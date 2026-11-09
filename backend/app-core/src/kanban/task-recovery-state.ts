import {taskRecoveryEligibility,activeRecoveryIssueIds} from '@nestos/kanban/integration';
import {recoveryWorkspace} from './recovery-workspace';
import {reviewKey,jobKey,type ReviewSettings,type ReviewJob} from './item-operation-types';
import {sha256HexSync} from '@nestos/common';
import type {KanbanTaskRecovery,KanbanBoard,KanbanItem,KanbanDispatch} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import {requireValue} from './validation';
export async function taskRecoveryState(options:TaskRecoveryOptions,boardId:string,itemId:string):Promise<KanbanTaskRecovery> {
    const board=await options.service.read(boardId),item=board.items.find(row=>row.id===itemId);requireValue(item,'ITEM_NOT_FOUND');
    const workflow=await options.service.workflow(boardId),dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===itemId).sort((a,b)=>b.attempt-a.attempt)[0];
    const blocked=await activeBlocker(options,board,item,dispatch);if(blocked)return blocked;
    const retainedScope=await recoveryWorkspace(options.journal,workflow,dispatch),record=retainedScope?.record;
    const delivery=(record?.context as {delivery?:{readOnly?:boolean;evidence?:{result?:{version?:string}}}})?.delivery;
    const target=await options.describe(item),expectedVersion=delivery?.evidence?.result?.version,actualVersion=target?.version;
    const sessionId=retainedScope?.dispatch.executionSessionId,resourceId=sessionId?await options.executionResource(sessionId,'main',board):undefined;
    const related=await Promise.all((item.planning?.dependencies??[]).map(async id=>{
        const source=board.items.find(row=>row.id===id),execution=Object.values(workflow.dispatches).filter(row=>row.itemId===id).sort((a,b)=>b.attempt-a.attempt)[0];
        const resourceId=execution?.executionSessionId?await options.executionResource(execution.executionSessionId,'main',board):undefined;
        return {itemId:id,title:source?.title??id,...optional({number:source?.number,resourceId})};
    }));
    const sourceIds=new Set(item.planning?.dependencies??[]),repairs=board.items.filter(row=>row.deletedAt===undefined&&(row.id===item.repairPending?.itemId||row.planning?.kind==='fix'&&row.planning.dependencies.some(id=>sourceIds.has(id))));
    const blockingItems=[...new Map([...board.items.filter(row=>sourceIds.has(row.id)),...repairs].filter(row=>row.status!=='completed').map(row=>[row.id,{id:row.id,title:row.title}])).values()];
    const candidates=[...sourceIds,...repairs.filter(row=>row.status==='completed').map(row=>row.id)],settings=await options.journal.getMany<ReviewSettings>(candidates.map(id=>reviewKey(boardId,id)));
    const jobs=await options.journal.getMany<ReviewJob>(settings.flatMap(row=>(row?.jobs??[]).map(jobKey)));
    const latest=jobs.filter((job):job is ReviewJob=>typeof actualVersion==='string'&&!!job&&job.boardId===boardId&&candidates.includes(job.itemId)&&board.items.find(row=>row.id===job.itemId)?.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record?.projectId)===true&&job.action==='deploy'&&job.state==='succeeded'&&job.phase==='settled'&&(job.result as {version?:string})?.version===actualVersion).sort((a,b)=>b.createdAt-a.createdAt)[0];
    const code=dispatch?.code??item.blocked?.reason;
    const retained=!!record&&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??retainedScope!.dispatch.id));
    return {itemId,related,blockingItems,...optional({sessionId,resourceId,code,expectedVersion,actualVersion,deliveryOperationId:latest?.id,deliveryItemId:latest?.itemId}),
        revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch?.id,dispatch?.outcome,code,expectedVersion,target?.id,actualVersion,latest?.id,repairs.map(row=>[row.id,row.revision,row.status])])),
        ...taskRecoveryEligibility(item,dispatch,{resourcesRetained:retained,blockingItemIds:blockingItems.map(row=>row.id),targetReady:!delivery?.readOnly||typeof expectedVersion==='string'&&(expectedVersion===actualVersion||!!latest),currentTargetSelectable:!latest&&delivery?.readOnly===true&&!!target&&actualVersion!==expectedVersion})};
}

async function activeBlocker(options:TaskRecoveryOptions,board:KanbanBoard,item:KanbanItem,dispatch:KanbanDispatch|undefined):Promise<KanbanTaskRecovery|undefined>{
    const pendingIssueIds=activeRecoveryIssueIds(item,dispatch);
    if(!dispatch||!pendingIssueIds.length)return;
    const sessionId=dispatch.executionSessionId,resourceId=sessionId?await options.executionResource(sessionId,'main',board):undefined;
    return {state:'blocked',itemId:item.id,pendingIssueIds,revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch.id,dispatch.outcome,pendingIssueIds])),related:[],canRetry:false,canSelectCurrentVersion:false,...optional({sessionId,resourceId,code:dispatch.code??item.blocked?.reason})};
}

/** Omit absent DTO fields before durable storage and strict channel hashing. */
function optional<T extends object>(value:T):Partial<T> {return Object.fromEntries(Object.entries(value).filter(([,field])=>field!==undefined)) as Partial<T>;}

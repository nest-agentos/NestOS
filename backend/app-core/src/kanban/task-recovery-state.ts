import {recoveryWorkspace} from './recovery-workspace';
import {reviewKey,jobKey,type ReviewSettings,type ReviewJob} from './item-operation-types';
import {sha256HexSync} from '@nestos/common';
import type {KanbanTaskRecovery} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import {requireValue} from './validation';
export async function taskRecoveryState(options:TaskRecoveryOptions,boardId:string,itemId:string):Promise<KanbanTaskRecovery> {
    const board=await options.service.read(boardId),item=board.items.find(row=>row.id===itemId);requireValue(item,'ITEM_NOT_FOUND');
    const workflow=await options.service.workflow(boardId),dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===itemId).sort((a,b)=>b.attempt-a.attempt)[0];
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
    const terminal=dispatch&&['failed','cancelled','rejected'].includes(dispatch.outcome)&&['backlog','open'].includes(item.status)&&item.control?.action!=='cancel',code=dispatch?.code??item.blocked?.reason;
    const retained=!!record&&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??retainedScope!.dispatch.id));
    return {itemId,related,blockingItems,...optional({sessionId,resourceId,code,expectedVersion,actualVersion,deliveryOperationId:latest?.id,deliveryItemId:latest?.itemId}),
        revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch?.id,dispatch?.outcome,code,expectedVersion,target?.id,actualVersion,latest?.id,repairs.map(row=>[row.id,row.revision,row.status])])),
        canRetry:!!terminal&&retained&&!blockingItems.length&&(!delivery?.readOnly||typeof expectedVersion==='string'&&(expectedVersion===actualVersion||!!latest)),
        canSelectCurrentVersion:!!terminal&&retained&&!blockingItems.length&&!latest&&delivery?.readOnly===true&&!!target&&actualVersion!==expectedVersion};
}

/** Omit absent DTO fields before durable storage and strict channel hashing. */
function optional<T extends object>(value:T):Partial<T> {return Object.fromEntries(Object.entries(value).filter(([,field])=>field!==undefined)) as Partial<T>;}

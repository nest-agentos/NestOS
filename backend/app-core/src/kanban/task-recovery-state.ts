import {folderBrowserPath,projectRelativePath,resolveBrowserTarget} from '@nestos/app-contracts';
import {taskRecoveryEligibility,activeRecoveryIssueIds} from '@nestos/kanban/integration';
import {recoveryWorkspace} from './recovery-workspace';
import {reportHandoffFailure,type ReviewSettings,type ReviewJob} from '@nestos/kanban-development';
import {reviewKey,jobKey} from '@nestos/kanban/integration';
import {sha256HexSync} from '@nestos/common';
import type {KanbanTaskRecovery,KanbanBoard,KanbanItem,KanbanDispatch} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import {requireValue} from './validation';
export async function taskRecoveryState(options:TaskRecoveryOptions,boardId:string,itemId:string):Promise<KanbanTaskRecovery> {
    const board=await options.service.read(boardId),item=board.items.find(row=>row.id===itemId);requireValue(item,'ITEM_NOT_FOUND');
    const workflow=await options.service.workflow(boardId),dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===itemId).sort((a,b)=>b.attempt-a.attempt)[0];
    const handoff=await reportHandoff(options,board,item,dispatch);if(handoff)return handoff;
    const blocked=await activeBlocker(options,board,item,dispatch);if(blocked)return blocked;
    const reportReceipt=dispatch&&['succeeded','accepted'].includes(dispatch.outcome)&&await options.journal.get<import('@nestos/kanban/contracts').KanbanRecoveryReceipt>('task-report-recovery:'+dispatch.id);
    if(reportReceipt&&dispatch&&['succeeded','accepted'].includes(dispatch.outcome))return {itemId,related:[],canRetry:false,canSelectCurrentVersion:false,
        revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch.id,dispatch.outcome])),
        reportReceipt:{operationId:reportReceipt.operationId,state:'accepted',checkedAt:Date.now()}};
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
    const eligibility=taskRecoveryEligibility(item,dispatch,{resourcesRetained:retained,blockingItemIds:blockingItems.map(row=>row.id),targetReady:!delivery?.readOnly||typeof expectedVersion==='string'&&(expectedVersion===actualVersion||!!latest),currentTargetSelectable:!latest&&delivery?.readOnly===true&&!!target&&actualVersion!==expectedVersion});
    const canRecheck=eligibility.canRetry&&record&&delivery?.readOnly!==true&&options.recheck?.supports(record);
    return {itemId,related,blockingItems,...(canRecheck?{canRecheck:true}:{}),...optional({sessionId,resourceId,code,expectedVersion,actualVersion,deliveryOperationId:latest?.id,deliveryItemId:latest?.itemId}),
        revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch?.id,dispatch?.outcome,code,expectedVersion,target?.id,actualVersion,latest?.id,repairs.map(row=>[row.id,row.revision,row.status])])),
        ...eligibility,canRetry:eligibility.canRetry&&!canRecheck};
}

async function reportHandoff(options:TaskRecoveryOptions,board:KanbanBoard,item:KanbanItem,dispatch:KanbanDispatch|undefined):Promise<KanbanTaskRecovery|undefined>{
    if(!dispatch||!['running','unknown'].includes(dispatch.outcome)||!item.issues?.some(issue=>issue.attemptId===dispatch.id&&!issue.resolvedBy))return;
    const code=await reportHandoffFailure(options.journal,dispatch.id);if(!code)return;
    const record=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id);
    const sessionId=dispatch.executionSessionId,resourceId=sessionId?await options.executionResource(sessionId,'main',board):undefined;
    const canRecheck=!!(options.reportHandoff&&record&&!board.executionControl?.paused&&!board.lifecycle&&board.deletedAt===undefined
        &&item.control?.action!=='cancel'&&item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record.projectId)
        &&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??dispatch.id)));
    const target=resourceId?.includes('/@harness/')?resolveBrowserTarget(resourceId):undefined;
    const reportResourceId=target?.kind==='remote'&&record&&item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record.projectId)
        ?folderBrowserPath(target.folder)+'/@files'+projectRelativePath(record.directory+'/_nestos/kanban'):undefined;
    const receipt=await options.journal.get<import('@nestos/kanban/contracts').KanbanRecoveryReceipt>('task-report-recovery:'+dispatch.id);
    return {itemId:item.id,reportHandoff:{code,canRecheck,...optional({reportResourceId,receipt})},related:[],canRetry:false,canSelectCurrentVersion:false,
        ...optional({sessionId,resourceId,code:dispatch.code}),
        revision:sha256HexSync(JSON.stringify([item.id,item.revision,board.revision,dispatch.id,dispatch.outcome,code,canRecheck]))};
}

async function activeBlocker(options:TaskRecoveryOptions,board:KanbanBoard,item:KanbanItem,dispatch:KanbanDispatch|undefined):Promise<KanbanTaskRecovery|undefined>{
    const pendingIssueIds=activeRecoveryIssueIds(item,dispatch);
    if(!dispatch||!pendingIssueIds.length)return;
    const sessionId=dispatch.executionSessionId,resourceId=sessionId?await options.executionResource(sessionId,'main',board):undefined;
    const canRecheck=sessionId&&!board.executionControl?.paused&&!board.lifecycle&&board.deletedAt===undefined&&dispatch.outcome==='running'&&pendingIssueIds.length===1&&
        item.issues?.some(issue=>issue.id===pendingIssueIds[0]&&issue.attemptId===dispatch.id&&issue.type==='error'&&issue.handler!=='parent')&&
        await canRecheckActiveWorkspace(options,dispatch.id);
    return {state:'blocked',itemId:item.id,pendingIssueIds,revision:sha256HexSync(JSON.stringify([item.id,item.revision,dispatch.id,dispatch.outcome,pendingIssueIds])),
        related:[],canRetry:false,canSelectCurrentVersion:false,...(canRecheck?{canRecheck:true}:{}),...optional({sessionId,resourceId,code:dispatch.code??item.blocked?.reason})};
}

async function canRecheckActiveWorkspace(options:TaskRecoveryOptions,dispatchId:string) {
    if(!options.recheck)return false;
    const record=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+dispatchId);
    const readOnly=(record?.context as {delivery?:{readOnly?:boolean}}|undefined)?.delivery?.readOnly;
    return !!record&&!readOnly&&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??dispatchId))&&options.recheck.supports(record);
}

/** Omit absent DTO fields before durable storage and strict channel hashing. */
function optional<T extends object>(value:T):Partial<T> {return Object.fromEntries(Object.entries(value).filter(([,field])=>field!==undefined)) as Partial<T>;}

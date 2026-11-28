import {sha256HexSync} from '@nestos/common';
import {kanbanTaskType,type KanbanBoard,type KanbanCommand,type KanbanDispatch,type KanbanItem,type KanbanTaskRecovery,type KanbanTaskRecoveryRequest} from '@nestos/kanban/contracts';
import {safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {decisionHarnessProfile,harnessSelectionFailure,harnessRetryTarget,selectProjectHarness,harnessPreparationKey,coordinationHarnessScope,type HarnessPreparation} from '../presets/kanban-harness-settings';
import {workProjectId} from './task-projects';
import {workContext} from './work-context';
import {requireValue} from './validation';
import type {RecoveryIntent,TaskRecoveryOptions} from './task-recovery-ports';

export async function taskHarnessRecovery(options:TaskRecoveryOptions,board:KanbanBoard,item:KanbanItem,dispatch?:KanbanDispatch) {
    const role:'coordination'|'execution'=kanbanTaskType(item)==='coordination'?'coordination':'execution';
    const code=role==='coordination'&&item.analysis?.state==='failed'?item.analysis.code:
        role==='execution'&&dispatch?.outcome==='failed'&&!dispatch.executionSessionId?dispatch.code:undefined;
    if(!code||!harnessSelectionFailure(code)||item.owner||item.control||item.restartPending||board.lifecycle||board.executionControl?.paused)return;
    const [actor,context]=await Promise.all([options.service.currentPrincipal(),workContext(options.journal,board,item)]);
    if(actor.kind!=='human'||!board.members?.some(member=>member.kind===actor.kind&&member.id===actor.id&&member.roles?.includes('coordinator')))return;
    const retry=role==='coordination'?item.launch?.analysisPreparation:dispatch?.continuation?.preparation;
    const projectId=role==='coordination'?(context.primaryProjectId??workProjectId(item)):workProjectId(item);
    if(!projectId)return;
    const attempt=role==='coordination'?coordinationHarnessScope(board.id,item.id,item.launch?.analysisEpoch):dispatch!.id;
    const failure=await options.journal.get<HarnessPreparation>(harnessPreparationKey(attempt));
    const profileId=harnessRetryTarget(retry,role)??decisionHarnessProfile(context,role)??failure?.profileId;
    if(failure?.projectId!==projectId||failure.profileId!==profileId||failure.role!==role||failure.code!==code)return;
    const revision=sha256HexSync(JSON.stringify([board.id,item.id,item.revision,role,profileId,code,dispatch?.id,projectId]));
    return {role,profileId,projectId,revision,code};
}

export function taskHarnessRecoveryView(item:KanbanItem,scope:NonNullable<Awaited<ReturnType<typeof taskHarnessRecovery>>>):KanbanTaskRecovery {
    return {itemId:item.id,revision:scope.revision,code:scope.code,related:[],canRetry:false,canSelectCurrentVersion:false,
        harnessReselection:{role:scope.role,profileId:scope.profileId}};
}

export async function prepareHarnessRecovery(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest,digest:string):Promise<RecoveryIntent> {
    const started=Date.now(),event={operationId:request.operationId,boardId,stage:'task.harness.reselect'};
    try {
        const board=await options.service.read(boardId),item=board.items.find(row=>row.id===request.itemId);
        requireValue(item,'ITEM_NOT_FOUND');
        const workflow=await options.service.workflow(boardId);
        const previous=Object.values(workflow.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        const scope=await taskHarnessRecovery(options,board,item,previous);
        requireValue(scope?.revision===request.expectedRevision,'RECOVERY_STALE_REFRESH');
        const requested=request.harnessProfileId;
        requireValue(typeof requested==='string'&&requested.length>0&&requested.length<=128,'DECISION_HARNESS_SELECTION_INVALID');
        const profileId=await selectProjectHarness(options.remote,scope.projectId,requested);
        const id='harness-retry-'+sha256HexSync(request.operationId).slice(0,48);
        const preparation={target:{system:'nestos-decision-harness-'+scope.role,id:profileId},expectedItemRevision:item.revision};
        const command:KanbanCommand=scope.role==='coordination'?{type:'retry-analysis',itemId:item.id,retryId:id,preparation}:
            {type:'continue-execution',previousDispatchId:previous!.id,dispatchId:id,preparation};
        const intent={boardId,request,digest,dispatchId:id,previousDispatchId:previous?.id??'',command};
        const validated=await options.journal.update<RecoveryIntent>('task-harness-retry:'+id,old=>old??intent);
        requireValue(validated.digest===digest,'IDEMPOTENCY_CONFLICT');
        options.log({...event,result:'success',durationMs:Date.now()-started});
        return validated;
    }catch(error){
        options.log({...event,result:'failure',code:safeCode(error,'KANBAN_HARNESS_UNAVAILABLE'),durationMs:Date.now()-started});
        throw error;
    }
}

export async function authorizeHarnessRecovery(journal:KanbanAutomationJournal,boardId:string,command:KanbanCommand):Promise<void> {
    if((command.type!=='retry-analysis'&&command.type!=='continue-execution')||!command.preparation)return;
    const key='task-harness-retry:'+(command.type==='retry-analysis'?command.retryId:command.dispatchId);
    const intent=await journal.get<RecoveryIntent>(key);
    requireValue(intent?.boardId===boardId&&JSON.stringify(intent.command)===JSON.stringify(command),'DECISION_HARNESS_SELECTION_INVALID');
}

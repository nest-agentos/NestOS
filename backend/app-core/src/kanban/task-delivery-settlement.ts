import {resolveBrowserTarget} from '@nestos/app-contracts';
import {sha256HexSync} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
import type {KanbanDispatch,KanbanItem,KanbanRequest,KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import {canSettleDelivery,taskRecoveryState} from './task-recovery-state';
import {requireValue} from './validation';

interface NativeTurn {sessionId?:string;turnId?:string;operationId?:string;status?:string}
interface Publication {id:string;message:{type:string;payload?:{handler?:string};replyTo?:string};origin?:NativeTurn}
interface Intent {digest:string;request:KanbanRequest;proof:string}
const outcomeCode='WORKSPACE_DELIVERY_INCOMPLETE';

export async function settleTaskDelivery(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult> {
    const started=Date.now(),event={operationId:request.operationId,boardId,stage:'task.recovery.delivery-settle'};
    try {
        const result=await settle(options,boardId,request);
        options.log({...event,result:'success',durationMs:Date.now()-started});
        return result;
    } catch(error) {
        options.log({...event,result:'failure',code:safeCode(error,'DELIVERY_SETTLEMENT_FAILED'),durationMs:Date.now()-started});
        throw error;
    }
}

async function settle(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult> {
    const actor=await options.service.currentPrincipal();
    requireValue(actor.kind==='human'&&request.confirmed===true,'RECOVERY_USER_CONFIRMATION_REQUIRED');
    const key='task-delivery-settlement:'+request.operationId,digest=sha256HexSync(JSON.stringify([boardId,actor,request]));
    const saved=await options.journal.get<Intent>(key);
    requireValue(!saved||saved.digest===digest,'IDEMPOTENCY_CONFLICT');
    const board=await options.service.read(boardId),item=board.items.find(row=>row.id===request.itemId);
    const workflow=await options.service.workflow(boardId);
    const dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===request.itemId).sort((a,b)=>b.attempt-a.attempt)[0];
    const command=saved?.request.command;
    const previous=command?.type==='observe-execution'?workflow.dispatches[command.dispatchId]:undefined;
    if(previous?.outcome==='failed'&&previous.code===outcomeCode)return {operationId:request.operationId,state:'accepted'};
    requireValue(item&&dispatch&&canSettleDelivery(board,item,dispatch),'RECOVERY_TARGET_NOT_READY');
    const state=await taskRecoveryState(options,boardId,item.id);
    requireValue(state.revision===request.expectedRevision&&state.resourceId,'RECOVERY_STALE_REFRESH');
    const proof=await terminalDeliveryProof(options,item,dispatch,state.resourceId);
    const intent=await options.journal.update<Intent>(key,old=>old??{digest,proof,request:{
        operationId:request.operationId,expectedRevision:board.revision,
        command:{type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'failed',code:outcomeCode},
    }});
    requireValue(intent.digest===digest&&intent.proof===proof,'RECOVERY_STALE_REFRESH');
    await options.service.execute(boardId,intent.request);
    return {operationId:request.operationId,state:'accepted'};
}

async function terminalDeliveryProof(options:TaskRecoveryOptions,item:KanbanItem,dispatch:KanbanDispatch,resourceId:string):Promise<string> {
    const target=resolveBrowserTarget(resourceId);
    const workspace=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id);
    requireValue(target.kind==='remote'&&target.nativeSessionId&&workspace?.channelId&&
        item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===workspace.projectId),'DELIVERY_SCOPE_UNVERIFIED');
    requireValue(!await options.journal.get('worktree-cleanup:'+(workspace.worktreeId??dispatch.id)),'CONTINUATION_WORKSPACE_UNAVAILABLE');
    const current=await options.remote.sessionChannel(workspace.projectId,'current',{cwd:workspace.directory}) as {scopeId?:string;execution?:NativeTurn};
    requireValue(current.scopeId===workspace.channelId&&current.execution?.sessionId===target.nativeSessionId,'DELIVERY_SCOPE_UNVERIFIED');
    const page=await options.remote.sessionChannel(workspace.projectId,'messages',{scopeId:workspace.channelId}) as {messages?:Publication[];execution?:NativeTurn};
    const turn=page.execution;
    requireValue(turn?.status==='completed'&&turn.sessionId===target.nativeSessionId&&turn.turnId&&turn.operationId&&
        current.execution.turnId===turn.turnId&&current.execution.operationId===turn.operationId,'DELIVERY_TURN_UNVERIFIED');
    requireValue(Array.isArray(page.messages)&&page.messages.length<=200&&!page.messages.some(row=>row.message?.type==='result'),'DELIVERY_RESULT_EXISTS');
    const report=terminalBlocker(page.messages,item,dispatch,turn);
    return sha256HexSync(JSON.stringify([workspace.projectId,workspace.channelId,dispatch.id,report.id,turn.sessionId,turn.turnId,turn.operationId]));
}


function terminalBlocker(messages:Publication[],item:KanbanItem,dispatch:KanbanDispatch,turn:NativeTurn):Publication {
    const resolved=new Set(messages.filter(row=>row.message?.type==='resolved').map(row=>row.message.replyTo));
    const issues=messages.filter(row=>['error','clarification'].includes(row.message?.type)&&!resolved.has(row.id));
    requireValue(issues.every(row=>row.message.type==='error'&&row.message.payload?.handler==='parent'&&
        item.issues?.some(issue=>issue.id===row.id&&issue.attemptId===dispatch.id&&!issue.resolvedBy)),'DELIVERY_BLOCKER_UNVERIFIED');
    const report=issues.find(row=>row.origin?.sessionId===turn.sessionId&&row.origin?.turnId===turn.turnId&&row.origin?.operationId===turn.operationId);
    requireValue(report,'DELIVERY_BLOCKER_UNVERIFIED');
    return report;
}

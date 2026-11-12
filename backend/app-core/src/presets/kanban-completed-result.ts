import {createModuleLogger} from '@nestos/common';
import type {ContinueWorkOptions,ContinuationContext} from '../kanban/continued-work';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import type {PreparedWorktree} from '@nestos/git-delivery/worktrees';
import {channelDigest} from '../run/channel-protocol';
import {requireValue} from '../kanban/validation';
interface Publication {id:string;message:{type:string;content:string;payload?:unknown};origin?:{sessionId:string;turnId:string;operationId:string}}
interface Proof {projectId:string;scopeId:string;resultId:string;digest:string;nativeSessionId:string;turnId:string;operationId:string}
interface Options {journal:KanbanAutomationJournal;remote:Pick<ProjectRemoteMountService,'sessionChannel'>;verifyDelivery(id:string):Promise<void>}
/** Adopt a proven later result in a new Dispatch; the cancelled predecessor and Kernel call stay immutable. */
export function developmentCompletedResult(options:Options):NonNullable<ContinueWorkOptions['completedResult']> {
    return {prepare:input=>prepareResult(options,input),inspect:(input,proof)=>inspectResult(options,input,proof)};
}
async function prepareResult(options:Options,input:ContinuationContext):Promise<Proof|undefined>{
        const started=Date.now();
        const original=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.originalDispatch.id);
        if(!original||!input.nativeSessionId)return;
        const receipt=await publication(options,original.projectId,original.channelId,input.nativeSessionId);if(!receipt)return;
        requireValue(input.item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===original.projectId),'WORKTREE_PROJECT_CHANGED');
        const tree=await options.journal.get<PreparedWorktree>('worktree:'+input.originalDispatch.id);
        requireValue(tree&&!await options.journal.get('worktree-cleanup:'+(original.worktreeId??input.originalDispatch.id)),'CONTINUATION_WORKSPACE_UNAVAILABLE');
        await options.verifyDelivery(input.originalDispatch.id);
        const proof:Proof={projectId:original.projectId,scopeId:original.channelId,resultId:receipt.id,digest:channelDigest(receipt),nativeSessionId:input.nativeSessionId,turnId:receipt.origin!.turnId,operationId:receipt.origin!.operationId};
        await options.journal.update<PreparedWorktree>('worktree:'+input.dispatch.id,old=>{requireValue(!old||old.id===tree.id,'CONTINUATION_WORKSPACE_CONFLICT');return old??tree;});
        await options.journal.update<DevelopmentWorkspaceRecord>('development-workspace:'+input.dispatch.id,old=>{
            requireValue(!old||(old.context as {recoveredDelivery?:Proof})?.recoveredDelivery?.digest===proof.digest,'CONTINUATION_WORKSPACE_CONFLICT');
            return old??{...original,channelId:input.dispatch.id,worktreeId:original.worktreeId??input.originalDispatch.id,context:{...original.context as object,recoveredDelivery:proof}};
        });
        createModuleLogger('kanban').info('Completed source result adopted',{operation:'kanban.continuation.result',operationId:input.dispatch.id,sourceDispatchId:input.originalDispatch.id,stage:'source.verify',result:'success',durationMs:Date.now()-started});
        return proof;
}
async function inspectResult(options:Options,input:ContinuationContext,value:unknown):Promise<import('@nestos/kanban/execution').KanbanExecutionObservation>{
        const started=Date.now();
        const proof=value as Proof;
        requireValue(proof?.nativeSessionId===input.nativeSessionId&&proof.scopeId===input.originalDispatch.id,'CONTINUATION_RESULT_SCOPE_MISMATCH');
        const original=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.originalDispatch.id);
        requireValue(original?.projectId===proof.projectId&&original.channelId===proof.scopeId,'CONTINUATION_RESULT_SCOPE_MISMATCH');
        const receipt=await publication(options,proof.projectId,proof.scopeId,proof.nativeSessionId);
        requireValue(receipt&&receipt.id===proof.resultId&&channelDigest(receipt)===proof.digest,'CONTINUATION_RESULT_CHANGED');
        await options.verifyDelivery(input.originalDispatch.id);
        const outputs=await options.journal.artifact(input.dispatch.id,{sourceDispatchId:input.originalDispatch.id,publication:receipt});
        createModuleLogger('kanban').info('Completed source result verified',{operation:'kanban.continuation.result',operationId:input.dispatch.id,sourceDispatchId:input.originalDispatch.id,stage:'source.accept',result:'success',durationMs:Date.now()-started});
        return {outcome:'succeeded',executionSessionId:input.sessionId,outputs};
}
async function publication(options:Options,projectId:string,scopeId:string,nativeSessionId:string):Promise<Publication|undefined> {
    const page=await options.remote.sessionChannel(projectId,'messages',{scopeId}) as {messages?:Publication[];execution?:{sessionId:string;turnId:string;operationId:string;status:string}};
    requireValue(Array.isArray(page.messages)&&page.messages.length<=200,'CHANNEL_MESSAGES_INVALID');
    const results=page.messages.filter(row=>row.message?.type==='result');if(!results.length)return;
    requireValue(results.length===1,'CHANNEL_RESULT_INVALID');
    const result=results[0];
    requireValue(completedPublication(page,nativeSessionId),'CONTINUATION_RESULT_UNVERIFIED');
    return result;
}

export function completedPublication(page:{messages?:Publication[];execution?:{sessionId?:string;turnId?:string;operationId?:string;status?:string}},nativeSessionId?:string):Publication|undefined {
    const results=page.messages?.filter(row=>row.message?.type==='result');if(results?.length!==1)return;
    const result=results[0],source=result.origin,execution=page.execution;
    if(source?.sessionId&&(!nativeSessionId||source.sessionId===nativeSessionId)&&source.turnId&&source.operationId&&execution?.sessionId===source.sessionId&&execution.turnId===source.turnId&&execution.operationId===source.operationId&&execution.status==='completed')return result;
}

import type {HarnessExecutionResult} from '@nestos/kernel-adapters/contracts';
import {HarnessContextBindings} from './harness-context-bindings';
import {executionError} from './harness-execution-journal';
import {refreshNativeHistory,finishNativeTurn} from './harness-execution-observation';
import type {NativeExecution} from './harness-execution-operations';

/** A restarted transport can read the exact admitted native turn, never replay its mutations. */
export async function recoverNativeTerminal(run:NativeExecution):Promise<HarnessExecutionResult> {
    const {data}=run.journal,turn=data.operations.turn;
    if(!data.sessionId||!data.turnId||turn?.outcome!=='committed'||(turn.result as {turnId?:string})?.turnId!==data.turnId)throw executionError('NATIVE_EPOCH_CHANGED');
    await assertOriginalContext(run);
    await refreshNativeHistory(run,run.acquired.epoch);
    if(!run.journal.data.terminal)throw executionError('NATIVE_EPOCH_CHANGED');
    await run.journal.save({outputChecked:true});
    return finishNativeTurn(run);
}
async function assertOriginalContext(run:NativeExecution):Promise<void> {
    const {request,acquired,journal}=run;
    if(acquired.profile.id!==request.connection.profileId)throw executionError('CONTEXT_NATIVE_SCOPE_CHANGED');
    if(!request.context)return;
    if(!journal.data.bindingId)throw executionError('CONTEXT_BINDING_NOT_FOUND');
    const binding=await new HarnessContextBindings(journal.state,journal.context.sessionId).get(journal.data.bindingId),native=binding?.nativeRef;
    if(!native||binding?.validity!=='valid'||binding.activeOperation?.operationId!==journal.contextOperation().operationId
        ||native.sessionId!==journal.data.sessionId||native.nodeConnectionId!==request.connection.nodeConnectionId
        ||native.profileId!==acquired.profile.id||native.workspaceId!==acquired.workspaceId)throw executionError('CONTEXT_NATIVE_SCOPE_CHANGED');
    if(!acquired.profile.contextId||native.epoch!==acquired.profile.contextId)throw executionError('CONTEXT_NATIVE_EPOCH_CHANGED');
}

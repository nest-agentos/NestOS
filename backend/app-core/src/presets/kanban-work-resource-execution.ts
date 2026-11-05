import {createModuleLogger} from '@nestos/common';
const log=createModuleLogger('kanban-worktree');
import {taskStat, type Kernel} from '@nestos/durable-kernel';
import {jobKey, reviewKey, type ReviewJob, type ReviewSettings} from '../kanban/item-operation-types';
import {readContextCatalog, type ContextInspector} from '../projects/harness-context-catalog';
import type {IndependentCallService} from '@nestos/llm-session';
import type {IndependentCallView} from '@nestos/llm-session/contracts';
import type {ProjectConversationPort} from '@nestos/app-contracts/services';
import type {ContextBinding} from '@nestos/kernel-adapters/contracts';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';

export interface ResourceExecutionOptions {
    calls: Pick<IndependentCallService, 'list'>; kernel: ContextInspector & Pick<Kernel,'task'>;
    remote: ProjectRemoteMountService; journal: KanbanAutomationJournal;
}
type NativeState = ReturnType<ProjectConversationPort['snapshot']>;
/** Inspect original calls and native turns without activating Sessions or acquiring writers. */
export async function workResourceExecution(options: ResourceExecutionOptions, id: string, projectId: string, query:{purpose?:'resume';operationId?:string}={}): Promise<string[]> {
    const callers = [id], reasons: string[] = [];
    for (const scope of await options.journal.get<Array<{board: string; item: string}>>('review-operation-scopes') ?? []) {
        const settings = await options.journal.get<ReviewSettings>(reviewKey(scope.board, scope.item));
        for (const key of settings?.jobs ?? []) {
            const job = await options.journal.get<ReviewJob>(jobKey(key));
            if ((query.purpose!=='resume'||job?.id!==query.operationId)&& job?.phase !== 'settled' && (job?.snapshot.context as {worktreeId?: string})?.worktreeId === id) return ['WORKTREE_IN_USE'];
        }
    }
    for (const key of await options.journal.get<string[]>('development-lifecycle-index') ?? []) {
        const job = await options.journal.get<{done?:boolean;observation?:{outcome:string};dispatch: {id: string}; request: {input: {request: {expectedSessionId: string}}}}>(key);
        if (job?.done && job.observation?.outcome === 'cancelled') continue;
        if (job?.dispatch.id.startsWith(id + '-postload-')) callers.push(job.request.input.request.expectedSessionId);
    }
    for (const sessionId of new Set(callers)) {
        const calls = await options.calls.list({sessionId});
        if (!calls.length) reasons.push('WORKTREE_EXECUTION_UNKNOWN');
        for (const call of calls) reasons.push(...await inspectCall(options, call, id, projectId,query.purpose==='resume',query.operationId));
    }
    return [...new Set(reasons)];
}
async function inspectCall(options: ResourceExecutionOptions, call: IndependentCallView, id: string, projectId: string,resume=false,operationId?:string): Promise<string[]> {
    if (!call.callerState?.settled || !call.executionTree?.settled) return ['WORKTREE_IN_USE'];
    const child = call.receipt?.executionSessionId;
    if (!child) return ['WORKTREE_EXECUTION_UNKNOWN'];
    const catalog = await readContextCatalog(options.kernel, child);
    const bindings = Object.values(catalog.value.bindings).filter(row => row.connectionId === 'work-' + id && row.nativeRef);
    if (!bindings.length) return ['WORKTREE_EXECUTION_UNKNOWN'];
    const reasons: string[] = [];
    for (const binding of bindings) {
        if (binding.activeOperation) {
            const owner = await options.kernel.task(child, binding.activeOperation.executionRef.taskId).catch(() => undefined);
            if (!owner) {reasons.push('WORKTREE_EXECUTION_UNKNOWN');continue;}
            if (!taskStat(owner).settled) {reasons.push('WORKTREE_IN_USE');continue;}
        }
        reasons.push(...await inspectNative(options.remote, binding, projectId,resume,operationId));
    }
    return reasons;
}
async function inspectNative(remote: ProjectRemoteMountService, binding: ContextBinding, projectId: string,resume=false,operationId?:string): Promise<string[]> {
    if (binding.validity !== 'valid') return ['WORKTREE_EXECUTION_UNKNOWN'];
    const started=Date.now();
    const native = binding.nativeRef!, view = await remote.projectConversation(projectId, native.profileId, native.sessionId, undefined, true);
    try {
        await view.read(); const state = view.snapshot(), reasons: string[] = [];
        if (nativeBusy(state,resume)) reasons.push('WORKTREE_IN_USE');
        if (nativeUnknown(state) || binding.activeOperation&&state.writerLock?.status!=='not-held'&&!((state.archived||resume&&state.observation?.owned)&&state.observation.execution==='idle')) reasons.push('WORKTREE_EXECUTION_UNKNOWN');
        if(operationId&&reasons.length)log.warn('Native session blocks workspace operation',{operation:'kanban.worktree.inspect',operationId,stage:'native.observe',result:'failure',code:reasons[0],writer:state.writerLock?.status,execution:state.observation?.execution,owned:state.observation?.owned,active:!!state.active,pending:!!state.pending,queued:state.instructionQueue?.items.length??0,draftPresent:!!state.draft?.trim(),durationMs:Date.now()-started});
        return reasons;
    } finally {await view.close();}
}
function nativeBusy(state: NativeState,resume=false): boolean {
    const idleOwner=(state.archived||resume&&state.observation?.owned===true)&&state.observation?.execution==='idle'&&!nativeUnknown(state);
    return !!(state.writerLock?.status === 'held'&&!idleOwner || state.active || state.pending || state.requests?.length || state.instructionQueue?.items.length || state.draft?.trim()
        || state.controls?.some(control => control.receipt === 'unknown' || control.receipt === 'accepted' && control.effect === 'unconfirmed'));
}
function nativeUnknown(state: NativeState): boolean {
    const observed = state.observation;
    return state.writerLock?.status==='unknown'||!observed || observed.stale || observed.connection !== 'online' || observed.receiptUnknown === true || observed.execution === 'unknown';
}

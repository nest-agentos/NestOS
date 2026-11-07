import {IndependentCallCommand, type IndependentCallStateControlRequest, type IndependentCallStateControlReceipt,
    type IndependentCallCancelRequest, type IndependentCallCancellationReceipt, type IndependentCallTreeCancellationReceipt,
    type IndependentCallView} from '@nestos/llm-session/contracts';
import type {IndependentCallService} from '@nestos/llm-session';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {requireValue} from './validation';

export interface CallLifecyclePorts {
    beforeCancel?:import('@nestos/kanban/integration').KanbanTaskControlOptions['beforeCancel'];
    controlConversation?(input:{scopeId:string;operationId:string;action:'pause'|'resume'|'cancel'}):Promise<import('../run/submission-control').SubmissionControlState>;
    calls: Pick<IndependentCallService, 'list'>;
    submissionControl?(input: import('../run/submission-control').SubmissionControlRequest, journal: import('../run/submission-control').ControlJournal): Promise<import('../run/submission-control').SubmissionControlState>;
    callControl?(command: string, request: IndependentCallStateControlRequest): Promise<IndependentCallStateControlReceipt>;
    callCancel?(command: string, request: IndependentCallCancelRequest): Promise<IndependentCallCancellationReceipt | IndependentCallTreeCancellationReceipt>;
}
interface Frozen {phase: 'prepared' | 'submitting'; command: string; query: IndependentCallStateControlRequest | IndependentCallCancelRequest}
export function callSettled(view: IndependentCallView): boolean {
    return view.callerState?.settled === true && view.executionTree?.settled === true;
}
/** Persist the exact route before writing; uncertain replies only inspect that request. */
export async function controlCall(options: CallLifecyclePorts, journal: KanbanAutomationJournal, sessionId: string,
    requestId: string, action: 'pause' | 'resume' | 'cancel', callId = sessionId, legacyKey?: string, directSubmission = false): Promise<'accepted' | 'paused' | 'resumed' | 'cancelled' | 'unknown'> {
    const views = await options.calls.list({sessionId, branchId: 'main'});
    const view = views.find(v => v.input.request.submission?.id === callId);
    if (!view && directSubmission && options.submissionControl) return options.submissionControl({sessionId, submissionId:callId, requestId, action}, journal);
    requireValue(view, 'TASK_CONTROL_ROUTE_MISSING');
    if(callSettled(view))return action==='cancel'?'cancelled':action==='pause'?'paused':'resumed';
    const key = 'call-lifecycle:' + JSON.stringify([sessionId, requestId]);
    let frozen = await journal.get<Frozen>(key);
    const legacy = !frozen && legacyKey ? await journal.get<Frozen>(legacyKey) : undefined;
    if (!frozen) frozen = await journal.update<Frozen>(key, old => old ?? legacy ?? freeze(view, sessionId, requestId, action, callId));
    requireValue(frozen.query.sessionId === sessionId && frozen.query.callId === callId && frozen.query.executionSessionId === view.receipt.executionSessionId && frozen.query.taskId === view.executionState?.id, 'TASK_CONTROL_SCOPE_MISMATCH');
    const submit = await journal.claim(key), {expectedEpoch: _epoch, ...query} = frozen.query;
    if (action === 'cancel') {
        requireValue(options.callCancel, 'TASK_CONTROL_UNSUPPORTED');
        const command = submit ? frozen.command : frozen.command === IndependentCallCommand.CancelRemaining
            ? IndependentCallCommand.TreeCancellationReceipt : IndependentCallCommand.CancellationReceipt;
        const result = await options.callCancel(command, (submit ? frozen.query : query) as IndependentCallCancelRequest);
        if (!result.receipt) return 'unknown';
        const latest = (await options.calls.list({sessionId, branchId: 'main'})).find(v => v.input.request.submission?.id === callId);
        return latest && callSettled(latest) ? 'cancelled' : 'accepted';
    }
    requireValue(options.callControl, 'TASK_CONTROL_UNSUPPORTED');
    const result = await options.callControl(submit ? IndependentCallCommand.Control : IndependentCallCommand.ControlReceipt,
        (submit ? frozen.query : query) as IndependentCallStateControlRequest);
    if (!result.receipt) return 'unknown';
    return result.receipt.current?.requestId === requestId && result.receipt.current.acknowledged ? action === 'pause' ? 'paused' : 'resumed' : 'accepted';
}
function freeze(view: IndependentCallView, sessionId: string, requestId: string, action: 'pause' | 'resume' | 'cancel', callId = sessionId): Frozen {
    const capability = view.controlCapabilities, state = view.executionState;
    const withdraw = action === 'resume' && state?.control?.requested === 'pause' && !state.control.acknowledged;
    requireValue(action === 'cancel' ? capability?.cancel : withdraw ? capability?.withdrawPause : action === 'pause' ? capability?.pause === 'boundary' : capability?.resume, 'TASK_CONTROL_UNSUPPORTED');
    requireValue(state && view.receipt.executionSessionId, 'TASK_CONTROL_ROUTE_MISSING');
    const remaining = action === 'cancel' && state.settled;
    requireValue(!remaining || capability?.cancelRemaining, 'TASK_CONTROL_UNSUPPORTED');
    return {phase: 'prepared', command: action === 'cancel' ? remaining ? IndependentCallCommand.CancelRemaining : IndependentCallCommand.Cancel : IndependentCallCommand.Control,
        query: {sessionId, branchId: 'main', callId, executionSessionId: view.receipt.executionSessionId, taskId: state.id,
            requestId, expectedEpoch: state.controlEpoch, ...(action === 'cancel' ? {} : {action: withdraw ? 'withdraw' as const : action})}};
}

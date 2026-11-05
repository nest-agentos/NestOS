import {cancelQueuedSubmission} from './submission-queue-control';
import {taskStat, type Kernel, type TaskRecord, type TaskControlReceipt} from '@nestos/durable-kernel';
import {FlowCommand, hasFlowControlTree} from '@nestos/llm-flow/contracts';
import type {ISessionRepository, Round} from '@nestos/llm-session/contracts';
import type {ConversationContexts} from '../runtime/conversation-contexts';
import {failure} from './prompt-bundle';
export interface ControlJournal {
    get<T>(key: string): Promise<T | undefined>;
    update<T>(key: string, change: (old: T | undefined) => T): Promise<T>;
    claim(key: string): Promise<boolean>;
}
export interface SubmissionControlRequest {sessionId: string; submissionId: string; requestId: string; action: 'pause' | 'resume' | 'cancel'}
export type SubmissionControlState = 'accepted' | 'paused' | 'resumed' | 'cancelled' | 'unknown';
interface Options {
    contexts: Pick<ConversationContexts, 'open'>; repository: Pick<ISessionRepository, 'readDocument' | 'getManifest'>;
    kernel: Kernel; ensureWritable?(sessionId: string): Promise<boolean>;
}
interface Frozen {phase: 'prepared' | 'submitting'; taskId: string; expectedEpoch: number; action: SubmissionControlRequest['action'] | 'withdraw'; flow: boolean; remaining: boolean}
function assert(value: unknown, code: string): asserts value {if (!value) throw failure(code);}
/** Control the exact persisted round in its existing Session, including continuations and maintenance. */
export function submissionControl(options: Options) {
    return async (input: SubmissionControlRequest, journal: ControlJournal): Promise<SubmissionControlState> => {
        const task = await originalTask(options, input);
        if (!task) return cancelQueuedSubmission(options, input, journal);
        if (input.action === 'cancel' && await treeSettled(options.kernel, task)) return 'cancelled';
        const key = 'submission-control:' + JSON.stringify([input.sessionId, input.submissionId, input.requestId]);
        const frozen = await journal.update<Frozen>(key, old => old ?? {phase:'prepared',taskId:task.id,expectedEpoch:task.control?.epoch ?? 0,
            action:input.action === 'resume' && task.control?.mode === 'pause' && !task.control.acknowledged ? 'withdraw' : input.action,
            flow:task.program.kind === 'flow.aggregate' || task.labels?.kind === 'flow-root', remaining:taskStat(task).settled});
        assert(frozen.taskId === task.id, 'SUBMISSION_EXECUTION_CONFLICT');
        if (frozen.phase === 'prepared') assert(!options.ensureWritable || await options.ensureWritable(input.sessionId), 'SESSION_WRITER_UNAVAILABLE');
        const write = await journal.claim(key);
        const receipt = frozen.flow ? await flowControl(options, input, frozen, write) : await taskControl(options.kernel, input, frozen, write);
        if (!receipt) return 'unknown';
        if (input.action === 'cancel') return await treeSettled(options.kernel, await options.kernel.task(input.sessionId, task.id)) ? 'cancelled' : 'accepted';
        const current = (receipt as TaskControlReceipt).current;
        return current?.requestId === input.requestId && current.acknowledged ? input.action === 'pause' ? 'paused' : 'resumed' : 'accepted';
    };
}
async function originalTask(options: Options, input: SubmissionControlRequest): Promise<TaskRecord | undefined> {
    const raw = await options.repository.readDocument(input.sessionId, 'round-' + input.submissionId + '.json');
    if (!raw) return;
    const round = JSON.parse(raw) as Round;
    assert(round.id === input.submissionId && round.sessionId === input.sessionId, 'SUBMISSION_HISTORY_CONFLICT');
    const primary = round.executions.find(row => row.role === 'primary'); assert(primary, 'SUBMISSION_EXECUTION_MISSING');
    const task = await options.kernel.task(input.sessionId, primary.taskId);
    assert(task.sessionId === input.sessionId && task.labels?.roundId === round.id, 'SUBMISSION_EXECUTION_CONFLICT');
    assert(task.program.kind !== 'flow.aggregate' && task.labels?.kind !== 'flow-root' || hasFlowControlTree(task), 'TASK_CONTROL_UNSUPPORTED');
    return task;
}
async function treeSettled(kernel: Kernel, task: TaskRecord): Promise<boolean> {
    const snapshot = await (await kernel.inspectSession(task.sessionId)).snapshot();
    const tree = snapshot.tasks.filter(row => row.id === task.id || task.rootTaskId && row.rootTaskId === task.rootTaskId);
    return taskStat(task).settled && tree.every(row => taskStat(row).settled);
}
async function taskControl(kernel: Kernel, input: SubmissionControlRequest, frozen: Frozen, write: boolean) {
    const {sessionId, requestId} = input, {taskId, expectedEpoch} = frozen, options = {requestId, expectedEpoch};
    if (input.action === 'cancel') {
        if (write) {
            if (frozen.remaining) await kernel.cancelRemainingTaskTree(sessionId, taskId, options);
            else await kernel.cancel(sessionId, taskId, 'Cancelled by owner', options);
        }
        return frozen.remaining ? kernel.readTaskTreeCancellationReceipt(sessionId, taskId, requestId) : kernel.readTaskCancellationReceipt(sessionId, taskId, requestId);
    }
    if (write) {
        if (frozen.action === 'withdraw') await kernel.withdrawTaskPause(sessionId, taskId, options);
        else await kernel.controlTask(sessionId, taskId, input.action === 'pause' ? 'pause' : 'run', options);
    }
    return kernel.readTaskControlReceipt(sessionId, taskId, requestId);
}
async function flowControl(options: Options, input: SubmissionControlRequest, frozen: Frozen, write: boolean) {
    const lease = await options.contexts.open(input.sessionId);
    const query = {sessionId:input.sessionId,taskId:frozen.taskId,requestId:input.requestId}, control = {...query,expectedEpoch:frozen.expectedEpoch};
    try {
        if (write) {
            await lease.commandBus.execute(FlowCommand.RunGet, query);
            if (input.action === 'cancel') await lease.commandBus.execute(frozen.remaining ? FlowCommand.RunCancelRemaining : FlowCommand.RunCancel, control);
            else if (frozen.action === 'withdraw') await lease.commandBus.execute(FlowCommand.RunPauseWithdraw, control);
            else await lease.commandBus.execute(FlowCommand.RunGoalUpdate, {...control,goal:{status:input.action === 'pause' ? 'paused' : 'active'}});
        }
        return lease.commandBus.execute(input.action === 'cancel' ? frozen.remaining ? FlowCommand.RunTreeCancellationReceipt : FlowCommand.RunCancellationReceipt : FlowCommand.RunControlReceipt, query);
    } finally {await lease.dispose();}
}

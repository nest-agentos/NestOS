import {taskStat, type Kernel} from '@nestos/durable-kernel';
import type {SessionInstruction} from '../contracts/instruction-queue';
import type {ISessionRepository} from '../persistence/types';
import type {PersistedRound} from '../persistence/round-types';

/** Inspect or stop the exact admitted execution. Never submit a replacement request. */
export async function inspectQueuedExecution(kernel: Kernel, repository: ISessionRepository, sessionId: string,
    item: SessionInstruction, stop: boolean): Promise<SessionInstruction['observation']> {
    let task = await originalTask(kernel, repository, sessionId, item);
    if (!task) {
        if (stop) throw Object.assign(new Error('QUEUE_HISTORY_INCOMPLETE'), {code: 'QUEUE_HISTORY_INCOMPLETE'});
        return {lastProgressAt: item.createdAt};
    }
    const receipt = await stopReceipt(kernel, sessionId, task, item.id, stop);
    if (stop) task = await kernel.task(sessionId, task.id);
    const activity = await kernel.sessionActivity(sessionId);
    const effect = Object.values(task.effects).find(effect => effect.status === 'indeterminate');
    const code = effect ? effect.error?.code ?? 'QUEUE_EXECUTION_INDETERMINATE' : task.status === 'blocked' ? 'QUEUE_EXECUTION_BLOCKED' : undefined;
    return {lastProgressAt: activity.lastActivityAt ?? item.createdAt, ...(code ? {code} : {}),
        ...(receipt && (!taskStat(task).settled || (await kernel.listSessionTasks(sessionId))
            .some(row => row.rootTaskId === task.rootTaskId && !taskStat(row).settled)) ? {stopping: true} : {})};
}

/** Freeze the cancellation fence before any external cancellation can begin. */
async function freezeStopEpoch(kernel: Kernel, sessionId: string, id: string, taskId: string, epoch: number): Promise<number> {
    const key = `conversation/instruction-stop/${id}`, session = await kernel.inspectSession(sessionId);
    let entry = await session.getShared(key);
    if (!entry) {
        try {entry = await (await kernel.openSession(sessionId)).setShared(key, {taskId, epoch}, {expectedVersion: null});}
        catch (error) {entry = await session.getShared(key); if (!entry) throw error;}
    }
    const frozen = entry.value as {taskId: string; epoch: number};
    if (frozen.taskId !== taskId || !Number.isSafeInteger(frozen.epoch))
        throw Object.assign(new Error('QUEUE_STOP_IDENTITY_CONFLICT'), {code: 'QUEUE_STOP_IDENTITY_CONFLICT'});
    return frozen.epoch;
}

async function originalTask(kernel: Kernel, repository: ISessionRepository, sessionId: string, item: SessionInstruction) {
    const raw = await repository.readDocument(sessionId, `round-${item.id}.json`);
    if (!raw) return undefined;
    const round = JSON.parse(raw) as PersistedRound, primary = round.executions.find(row => row.role === 'primary');
    if (round.id !== item.id || round.sessionId !== sessionId || !primary?.invocation
        || primary.invocation.invocationId !== item.invocation?.invocationId)
        throw Object.assign(new Error('QUEUE_HISTORY_EXECUTION_CONFLICT'), {code: 'QUEUE_HISTORY_EXECUTION_CONFLICT'});
    const task = await kernel.task(sessionId, primary.taskId);
    if (task.sessionId !== sessionId || task.labels?.roundId !== item.id || task.labels?.invocationId !== item.invocation?.invocationId)
        throw Object.assign(new Error('QUEUE_HISTORY_EXECUTION_CONFLICT'), {code: 'QUEUE_HISTORY_EXECUTION_CONFLICT'});
    return task;
}

async function stopReceipt(kernel: Kernel, sessionId: string, task: Awaited<ReturnType<Kernel['task']>>, id: string, stop: boolean) {
    const requestId = `queue-stop-${id}`;
    const receipt = await kernel.readTaskCancellationReceipt(sessionId, task.id, requestId)
        ?? (task.exit ? await kernel.readTaskTreeCancellationReceipt(sessionId, task.id, requestId) : undefined);
    if (receipt || !stop) return receipt;
    const expectedEpoch = await freezeStopEpoch(kernel, sessionId, id, task.id, task.control?.epoch ?? 0);
    if (task.exit) {
        await kernel.cancelRemainingTaskTree(sessionId, task.id, {requestId, expectedEpoch, reason: 'User stopped remaining queued execution'});
        return kernel.readTaskTreeCancellationReceipt(sessionId, task.id, requestId);
    }
    await kernel.cancel(sessionId, task.id, 'User stopped the original queued execution', {requestId, expectedEpoch});
    return kernel.readTaskCancellationReceipt(sessionId, task.id, requestId);
}

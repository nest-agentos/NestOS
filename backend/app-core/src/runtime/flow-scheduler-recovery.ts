import {createModuleLogger, randomUUID} from '@nestos/common';
import type {TaskRecord} from '@nestos/durable-kernel/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import {FlowCommand} from '@nestos/llm-flow/contracts';
import type {ICommandBus} from '@nestos/llm-session/contracts';
import {mapConcurrent} from '../utils/map-concurrent';

const log = createModuleLogger('flow-scheduler-recovery');
/** Reattach admitted Flow schedulers, including reruns which have no invocation journal. */
export async function recoverFlowSchedulers(kernel: Pick<Kernel, 'listRecoveryTasks' | 'task'>, commands: ICommandBus,
    writable: (sessionId: string) => Promise<boolean>): Promise<() => void> {
    const disposers: (() => void)[] = [];
    const started = Date.now(), operationId = randomUUID();
    const candidates = await kernel.listRecoveryTasks('flow.scheduler');
    let failures = 0;
    await mapConcurrent(candidates, 8, async ref => {
        const scanStarted = Date.now();
        try {
            const root = await kernel.task(ref.sessionId, ref.taskId);
            if (needsScheduler(root)) disposers.push(await recoverRoot(ref.sessionId, root.id, commands, writable));
        } catch (error) {failures++; report(ref.sessionId, operationId, 'candidate', scanStarted, error);}
    });
    console.info('[FlowRecovery]', {operation: 'flow.scheduler.recover', operationId, stage: 'scan',
        result: failures ? 'partial' : 'success', candidateCount: candidates.length, rootCount: disposers.length,
        failureCount: failures, concurrency: 8, durationMs: Date.now() - started});
    return () => disposers.forEach(dispose => dispose());
}
function needsScheduler(task: TaskRecord): boolean {
    if (task.sessionPaused || task.ownedBy && task.status === 'created' || task.program.kind !== 'flow.aggregate' || task.labels?.kind !== 'flow-root'
        || ['succeeded', 'failed', 'cancelled'].includes(task.status)) return false;
    const state = task.state ?? task.input;
    return !!state && typeof state === 'object' && !Array.isArray(state) && 'awaitingSchedule' in state && state.awaitingSchedule === true;
}
async function recoverRoot(sessionId: string, taskId: string, commands: ICommandBus,
    writable: (sessionId: string) => Promise<boolean>): Promise<() => void> {
    let closed = false, attempts = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {if (!closed) timer = setTimeout(() => {void attempt();}, Math.min(30_000, 1000 * 2 ** attempts++));};
    const attempt = async () => {
        const started = Date.now();
        try {
            if (closed) return;
            if (!await writable(sessionId)) {schedule(); return;}
            if (closed) return;
            await commands.execute(FlowCommand.RunResume, {sessionId, taskId});
            report(sessionId, taskId, 'reattach', started);
        } catch (error) {
            if (closed) return;
            report(sessionId, taskId, 'reattach', started, error);
            if ((error as {code?: string})?.code === 'FLOW_SCHEDULER_BUSY')
                schedule();
        }
    };
    await attempt();
    return () => {closed = true; clearTimeout(timer);};
}
function report(sessionId: string, operationId: string, stage: string, started: number, error?: unknown): void {
    const code = (error as {code?: unknown})?.code;
    const detail = {operation: 'flow.scheduler.recover', sessionId, operationId, stage,
        result: error ? 'deferred' : 'attached', code: error ? typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'FLOW_SCHEDULER_RECOVERY_FAILED' : undefined,
        durationMs: Date.now() - started};
    if (error) log.warn('flow.scheduler.recover', detail); else log.info('flow.scheduler.recover', detail);
}

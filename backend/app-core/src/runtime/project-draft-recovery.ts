import {randomUUID} from '@nestos/common';
import type {SessionManager} from '@nestos/llm-session';
import type {ProjectDraftService} from '../projects/drafts/service';
import {diagnosticFailure} from '../diagnostics/failure';

type Recovery = Pick<ProjectDraftService, 'recover' | 'submitted'>;
interface RecoveryEvent {
    operationId: string; stage: string; result: 'success' | 'failure'; code?: string; projectId?: string; durationMs: number;
}
interface RecoveryOptions {periodic?: boolean; report?: (event: RecoveryEvent) => void}

/** Own periodic receipt checks, sharing scans and draining work before storage closes. */
class DraftRecovery {
    private readonly pending = new Set<Promise<void>>();
    private closed = false;
    private running?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private delay = 15000;
    constructor(private readonly drafts: Recovery, private readonly options: RecoveryOptions) {}
    private report(event: RecoveryEvent): void {
        if (this.options.report) this.options.report(event);
        else if (event.result === 'failure') console.warn('[ProjectDraftRecovery]', event);
    }
    private track(work: Promise<void>): Promise<void> {
        this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => {}); return work;
    }
    recover(): Promise<void> {
        if (this.closed) return Promise.resolve();
        if (this.running) return this.running;
        clearTimeout(this.timer);
        const operationId = randomUUID(), started = Date.now();
        const deferred = (projectId: string, error: unknown) => this.report({operationId, projectId, stage: 'reconcile',
            result: 'failure', ...diagnosticFailure(error), durationMs: Date.now() - started});
        this.running = this.track(Promise.resolve().then(() => this.drafts.recover(undefined, undefined, deferred)).then(() => {
            this.delay = 15000; this.report({operationId, stage: 'scan', result: 'success', durationMs: Date.now() - started});
        }, error => {
            this.report({operationId, stage: 'scan', result: 'failure',
                ...diagnosticFailure(error instanceof AggregateError ? error.errors[0] : error), durationMs: Date.now() - started});
            throw error;
        }).finally(() => {this.running = undefined; this.schedule();}));
        return this.running;
    }
    private schedule(): void {
        if (this.closed || !this.options.periodic) return;
        this.timer = setTimeout(() => {void this.recover().catch(() => {});}, this.delay);
        this.delay = Math.min(60000, this.delay * 2);
    }
    submitted(event: Parameters<Recovery['submitted']>[0]): void {
        if (this.closed) return;
        const operationId = randomUUID(), started = Date.now();
        void this.track(this.drafts.submitted(event).catch(error => this.report({operationId, stage: 'submitted', result: 'failure',
            ...diagnosticFailure(error), durationMs: Date.now() - started})));
    }
    async close(): Promise<void> {
        this.closed = true; clearTimeout(this.timer); await Promise.allSettled(this.pending);
    }
}

/** Wire notifications once per view; only the runtime owns periodic checks. */
export async function attachProjectDraftRecovery(drafts: Recovery,
    sessions: Pick<SessionManager, 'onGlobalEvent'>, recoverInitially = true, options: RecoveryOptions = {}) {
    const recovery = new DraftRecovery(drafts, options);
    const unsubscribe = sessions.onGlobalEvent(event => {
        if (event.type === 'execution_task_projected') recovery.submitted(event.payload);
    });
    if (recoverInitially) void recovery.recover().catch(() => {});
    let closing: Promise<void> | undefined;
    return Object.assign(() => closing ??= (async () => {unsubscribe(); await recovery.close();})(), {recover: () => recovery.recover()});
}

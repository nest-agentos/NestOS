import {workerError} from './channel';
interface Waiter {signal?: AbortSignal; grant(): void; abort(): void}

/** Bounded, cancellable admission; queued work never starts after its owner stops. */
export class ToolWorkerPool {
    private active = 0;
    private readonly waiting: Waiter[] = [];
    constructor(private readonly limit: number) {}
    async run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
        const release = await this.acquire(signal);
        try {signal?.throwIfAborted(); return await work();} finally {release();}
    }
    private acquire(signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted();
        if (this.active < this.limit) {this.active++; return Promise.resolve(() => this.release());}
        if (this.waiting.length >= 256) return Promise.reject(workerError('TOOL_WORKER_QUEUE_FULL'));
        return new Promise((resolve, reject) => {
            const waiter: Waiter = {signal, grant: () => {signal?.removeEventListener('abort', waiter.abort); this.active++; resolve(() => this.release());},
                abort: () => {const index = this.waiting.indexOf(waiter); if (index >= 0) this.waiting.splice(index, 1); reject(signal?.reason);}};
            this.waiting.push(waiter); signal?.addEventListener('abort', waiter.abort, {once: true});
            if (signal?.aborted) waiter.abort();
        });
    }
    private release(): void {
        this.active--;
        const next = this.waiting.shift(); if (next) next.grant();
    }
}
export const toolWorkerBudget = new ToolWorkerPool(8);

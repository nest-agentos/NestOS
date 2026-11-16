interface Retry {attempt: number; delayMs: number; durationMs: number; operationId: string}

/** Re-read only the immutable prepared packet; never replay its callbacks or commands. */
export class PreparedUpdateReader<T> {
    private readonly waiters = new Set<() => void>();
    constructor(private readonly signal: AbortSignal, private readonly fetch: (id: string) => Promise<T>,
        private readonly report: (error: unknown, retry: Retry) => void) {}
    async read(id: string): Promise<T> {
        const started = Date.now();let attempt = 0;
        while (true) {
            this.signal.throwIfAborted();
            try {return await this.fetch(id);} catch (error) {
                this.signal.throwIfAborted();
                const code = (error as {code?: string})?.code;
                if (code !== 'HTTP_CONNECTION_LOST' && code !== 'HTTP_RESPONSE_READ_FAILED') throw error;
                const delayMs = Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4));
                this.report(error, {attempt, delayMs, durationMs: Date.now() - started, operationId: id});
                await this.pause(delayMs);
            }
        }
    }
    retry(): void {for (const wake of [...this.waiters]) wake();}
    private pause(delay: number): Promise<void> {
        this.signal.throwIfAborted();
        return new Promise(resolve => {
            const done = () => {
                clearTimeout(timer);this.waiters.delete(done);this.signal.removeEventListener('abort', done);resolve();
            };
            const timer = setTimeout(done, delay);this.waiters.add(done);this.signal.addEventListener('abort', done, {once: true});
        });
    }
}

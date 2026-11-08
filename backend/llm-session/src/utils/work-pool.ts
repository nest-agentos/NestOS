/** Bound active I/O phases; durable waiting must happen outside this pool. */
export class WorkPool {
    private active = 0;
    private readonly waiting: Array<() => void> = [];
    constructor(private readonly limit: number) {
        if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Work concurrency must be positive');
    }
    async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) await new Promise<void>(resolve => this.waiting.push(resolve));
        else this.active++;
        try {return await work();}
        finally {
            const next = this.waiting.shift();
            if (next) next(); else this.active--;
        }
    }
}

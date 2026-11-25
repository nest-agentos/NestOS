import {createModuleLogger, sha256HexSync} from '@nestos/common';
import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from './outbox-index';
import type {DreamHost, DreamRecomputePlan} from './host';

const log = createModuleLogger('dream-recompute');
const prefix = 'recompute-request:';
interface Request {plan: DreamRecomputePlan; state: 'pending' | 'done' | 'superseded'; attempt?: number; retryAt?: number; lastCode?: string}
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** Background reconciliation persists stable requests before invoking the model. */
export class DreamRecompute {
    private dreamCursor?: string;
    private catalogCursor?: string;
    private requestCursor?: string;
    private running?: Promise<void>;
    private readonly notes = new Set<Promise<void>>();
    private stopped = false;
    constructor(private readonly fs: IFileSystem, private readonly host: Pick<DreamHost, 'planRecomputation' | 'executeRecomputation'>
        & Partial<Pick<DreamHost, 'recomputeCatalog'>>, private readonly now = () => Date.now()) {}

    noteChange(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        const work = this.persistChange(); this.notes.add(work);
        void work.then(() => this.notes.delete(work), () => this.notes.delete(work));
        return work;
    }
    private async persistChange(): Promise<void> {
        if (this.stopped || !await this.fs.driver.exists(DREAM_OUTBOX_INDEX)) return;
        await this.fs.meta.seq!.transaction!(async tx => {await tx.increment(DREAM_OUTBOX_INDEX, 'recompute-generation', 1);});
    }
    async scan(): Promise<void> {
        if (this.stopped) return;
        if (this.running) return this.running;
        this.running = this.scanPage().finally(() => {this.running = undefined;});
        return this.running;
    }
    async quiesce(): Promise<void> {this.stopped = true; await Promise.allSettled(this.notes); await this.running;}

    private async scanPage(): Promise<void> {
        try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        if (this.host.recomputeCatalog) {
            const catalog = await this.host.recomputeCatalog(this.catalogCursor); this.catalogCursor = catalog.next;
            await this.fs.meta.seq!.transaction!(async tx => {
                for (const item of catalog.items) {
                    if (!valid(item.owner) || !valid(item.dream)) throw new Error('DREAM_RECOMPUTE_INVALID');
                    const key = dreamOutboxKey(item.owner, item.dream);
                    if (!await tx.getEntry(DREAM_OUTBOX_INDEX, key)) await tx.setEntry(DREAM_OUTBOX_INDEX, key, JSON.stringify(item));
                }
            });
        }
        const dreams: Array<{key: string; value: string}> = [];
        await this.fs.meta.seq!.walkEntries(DREAM_OUTBOX_INDEX, row => {dreams.push(row); return true;},
            {keyPrefix: 'dream:', order: 'key', after: this.dreamCursor, limit: 50});
        this.dreamCursor = dreams.length === 50 ? dreams[dreams.length - 1].key : undefined;
        for (const row of dreams) {
            if (this.stopped) return;
            try {
                const value = JSON.parse(row.value) as {owner: string; dream: string};
                if (!valid(value.owner) || !valid(value.dream) || row.key !== `dream:${JSON.stringify([value.owner, value.dream])}`)
                    throw new Error('DREAM_RECOMPUTE_INVALID');
                for (const plan of await this.host.planRecomputation(value.owner, value.dream)) await this.enqueue(plan);
            } catch (error) {this.failure('inspect', 'recompute-scan', error);}
        }
        const requests: Array<{key: string; value: string}> = [];
        await this.fs.meta.seq!.walkEntries(DREAM_OUTBOX_INDEX, row => {requests.push(row); return true;},
            {keyPrefix: prefix, order: 'key', after: this.requestCursor, limit: 50});
        this.requestCursor = requests.length === 50 ? requests[requests.length - 1].key : undefined;
        for (const row of requests) {
            if (this.stopped) return;
            await this.process(row).catch(error => this.failure('read', 'recompute-scan', error));
        }
    }
    private async enqueue(plan: DreamRecomputePlan): Promise<void> {
        validate(plan);
        const key = prefix + JSON.stringify(plan.id), value = JSON.stringify({plan, state: 'pending'} satisfies Request);
        await this.fs.meta.seq!.transaction!(async tx => {
            const previous = await tx.getEntry(DREAM_OUTBOX_INDEX, key);
            if (!previous) await tx.setEntry(DREAM_OUTBOX_INDEX, key, value);
            else if (JSON.stringify((JSON.parse(previous) as Request).plan) !== JSON.stringify(plan)) throw new Error('DREAM_OPERATION_CONFLICT');
        });
    }
    private async process(row: {key: string; value: string}): Promise<void> {
        const request = JSON.parse(row.value) as Request; validate(request.plan);
        if (row.key !== prefix + JSON.stringify(request.plan.id) || !['pending', 'done', 'superseded'].includes(request.state)
            || request.attempt !== undefined && (!Number.isSafeInteger(request.attempt) || request.attempt < 0 || request.attempt > 1000)
            || request.retryAt !== undefined && (!Number.isSafeInteger(request.retryAt) || request.retryAt < 0))
            throw new Error('DREAM_RECOMPUTE_INVALID');
        if (request.state !== 'pending' || request.retryAt !== undefined && request.retryAt > this.now()) return;
        const started = Date.now();
        try {
            const current = await this.host.planRecomputation(request.plan.owner, request.plan.dream);
            if (!current.some(plan => plan.id === request.plan.id)) {
                await this.finish(row, {...request, state: 'superseded', lastCode: 'DREAM_RECOMPUTE_STALE'}); return;
            }
            await this.host.executeRecomputation(request.plan, request.attempt ?? 0);
            const {retryAt: _retryAt, ...complete} = request;
            await this.finish(row, {...complete, state: 'done'});
            log.info('dream.recompute', {operationId: request.plan.id, stage: 'settle', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = this.failure('execute', request.plan.id, error, started);
            if (['DREAM_CONFIG_CONFLICT', 'DREAM_VERSION_CONFLICT', 'DREAM_SOURCE_BINDING_CHANGED'].includes(code))
                await this.finish(row, {...request, state: 'superseded', lastCode: code});
            else {
                const attempt = request.attempt ?? 0;
                const retryAsNew = ['DREAM_OPERATION_CONFLICT', 'DREAM_CONSOLIDATION_EXECUTION_FAILED', 'DREAM_CONSOLIDATION_OUTPUT_INVALID'].includes(code);
                await this.finish(row, {...request, attempt: retryAsNew ? Math.min(1000, attempt + 1) : attempt,
                    retryAt: this.now() + Math.min(60000, 1000 * 2 ** Math.min(attempt, 6)), lastCode: code});
            }
        }
    }
    private async finish(row: {key: string; value: string}, request: Request): Promise<void> {
        await this.fs.meta.seq!.transaction!(async tx => {
            if (await tx.getEntry(DREAM_OUTBOX_INDEX, row.key) === row.value)
                await tx.setEntry(DREAM_OUTBOX_INDEX, row.key, JSON.stringify(request));
        });
    }
    private failure(stage: string, operationId: string, error: unknown, started = Date.now()): string {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_RECOMPUTE_FAILED';
        log.warn('dream.recompute', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); return code;
    }
}
function validate(plan: DreamRecomputePlan): void {
    if (!plan || ![plan.owner, plan.dream, plan.project, plan.id].every(valid) || plan.activeVersion !== null && !valid(plan.activeVersion)
        || !Number.isSafeInteger(plan.configRevision) || plan.configRevision < 1 || !Array.isArray(plan.sources)
        || !plan.sources.length || plan.sources.length > 32 || plan.sources.some(item => !valid(item.sourceId) || !valid(item.operationId))
        || new Set(plan.sources.map(item => item.sourceId)).size !== plan.sources.length
        || plan.id !== 'recompute-' + sha256HexSync(JSON.stringify([plan.owner, plan.dream, plan.project, plan.configRevision, plan.activeVersion, plan.sources])))
        throw new Error('DREAM_RECOMPUTE_INVALID');
}

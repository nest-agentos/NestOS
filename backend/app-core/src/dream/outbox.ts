import {createModuleLogger} from '@nestos/common';
import {MemoryCommitStore, type MemoryCommittedEvent} from '@nestos/dream/vfs';
import type {IFileSystem} from '@nestos/vfs-core';
import {DREAM_OUTBOX_INDEX} from './evidence-store';
import type {DreamDownstream} from './downstream';

const log = createModuleLogger('dream-outbox');
const consumers = ['daily', 'kanban'] as const;
const key = (kind: string, id: string) => `${kind}:${JSON.stringify(id)}`;
const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

/** Transfers committed references to independent durable consumer inboxes. */
export class DreamOutbox {
    private cursor?: string;
    private readonly offsets = new Map<string, number>();
    private running?: Promise<void>;
    private stopped = false;
    constructor(private readonly fs: IFileSystem, private readonly downstream?: DreamDownstream) {}

    async hasPendingIndex(): Promise<boolean> {return this.fs.driver.exists(DREAM_OUTBOX_INDEX);}
    async scan(): Promise<void> {
        if (this.stopped) return;
        if (this.running) return this.running;
        this.running = this.scanPage().finally(() => {this.running = undefined;});
        return this.running;
    }
    async quiesce(): Promise<void> {this.stopped = true; await this.running;}

    private async scanPage(): Promise<void> {
        if (!await this.hasPendingIndex()) return;
        const rows: Array<{key: string; value: string}> = [];
        const errors: unknown[] = [];
        await this.fs.meta.seq!.walkEntries(DREAM_OUTBOX_INDEX, row => {rows.push(row); return true;},
            {keyPrefix: 'dream:', order: 'key', after: this.cursor, limit: 50});
        this.cursor = rows.length === 50 ? rows[rows.length - 1].key : undefined;
        for (const row of rows) {
            if (this.stopped) return;
            try {
                const scope = JSON.parse(row.value) as {owner: string; dream: string};
                if (!valid(scope.owner) || !valid(scope.dream) || row.key !== `dream:${JSON.stringify([scope.owner, scope.dream])}`)
                    throw new Error('DREAM_OUTBOX_INDEX_INVALID');
                await this.deliverScope(scope.owner, scope.dream);
            } catch (error) {errors.push(error);}
        }
        if (errors.length) throw new AggregateError(errors, 'DREAM_OUTBOX_SCAN_FAILED');
    }

    private async deliverScope(owner: string, dream: string): Promise<void> {
        const path = `/var/lib/projects/${owner}/dream/${dream}/evidence.seq`;
        if (!await this.fs.driver.exists(path)) return;
        const store = new MemoryCommitStore(operation => this.fs.meta.seq!.transaction!(operation), path);
        for (const consumer of consumers) {
            const identity = JSON.stringify([owner, dream, consumer]), after = this.offsets.get(identity) ?? 0;
            const page = await store.pending(consumer, after, 50);
            for (const item of page.items) await this.deliver(path, consumer, item.event);
            if (page.next === after) this.offsets.delete(identity); else this.offsets.set(identity, page.next);
        }
        if (this.downstream) for (const consumer of consumers) await this.consumeScope(owner, dream, path, consumer);
    }

    private async consumeScope(owner: string, dream: string, path: string, consumer: typeof consumers[number]): Promise<void> {
        const identity = JSON.stringify([owner, dream, 'consumer', consumer]), after = this.offsets.get(identity) ?? 0;
        const rows: Array<{value: string}> = [];
        await this.fs.meta.seq!.walkEntries(path, row => {rows.push(row); return true;},
            {keyPrefix: `consumer-inbox:${consumer}:`, order: 'key', offset: after, limit: 50});
        for (const row of rows) {
            const started = Date.now(), event = JSON.parse(row.value) as MemoryCommittedEvent;
            if (!valid(event.commitId)) throw new Error('DREAM_OUTBOX_INVALID');
            try {
                if (!await this.fs.meta.seq!.getEntry(path, key(`consumer-result:${consumer}`, event.commitId))) {
                    await this.downstream!.consume(owner, dream, consumer, event);
                    log.info('dream.outbox.consume', {operationId: event.commitId, stage: consumer, result: 'success', durationMs: Date.now() - started});
                }
            } catch (error) {
                const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CONSUMER_FAILED';
                log.warn('dream.outbox.consume', {operationId: event.commitId, stage: 'consume', result: 'failure', code, durationMs: Date.now() - started});
            }
        }
        if (rows.length < 50) this.offsets.delete(identity); else this.offsets.set(identity, after + rows.length);
    }

    private async deliver(path: string, consumer: string, event: MemoryCommittedEvent): Promise<void> {
        const started = Date.now(), operationId = event.commitId;
        try {
            await this.fs.meta.seq!.transaction!(async tx => {
                const inbox = key(`consumer-inbox:${consumer}`, event.commitId);
                const receipt = key('outbox-delivered', JSON.stringify([consumer, event.commitId]));
                const encoded = JSON.stringify(event), previous = await tx.getEntry(path, inbox);
                if (previous && previous !== encoded) throw new Error('DREAM_OUTBOX_CONFLICT');
                if (!previous) await tx.setEntry(path, inbox, encoded);
                await tx.setEntry(path, receipt, '1');
            });
            log.info('dream.outbox.deliver', {operationId, stage: consumer, result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_OUTBOX_DELIVERY_FAILED';
            log.warn('dream.outbox.deliver', {operationId, stage: consumer, result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
}

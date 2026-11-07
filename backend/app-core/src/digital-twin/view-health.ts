import type {ISeqFileTransaction} from '@nestos/vfs-core';
import type {TwinRecord} from './contracts';
import {TwinSeqPages} from './seq-pages';
const key = 'view-health/cleanup-errors';
/** Cleanup failures remain visible even when their jobs are outside the current page. */
export class TwinViewHealth {
    constructor(private readonly indexes: string, private readonly knowledge: string) {}
    async read(tx: ISeqFileTransaction): Promise<string> {
        if (!await tx.getEntry(this.indexes, 'view-health/ready-v1')) await this.rebuild(tx);
        return Object.values(JSON.parse(await tx.getEntry(this.indexes, key) ?? '{}') as Record<string, string>)[0] ?? '';
    }
    async put(tx: ISeqFileTransaction, record: TwinRecord): Promise<void> {
        if (record.family !== 'job') return;
        const errors = JSON.parse(await tx.getEntry(this.indexes, key) ?? '{}');
        if (record.payload.cleanupError && !record.payload.cleaned) errors[record.id] = record.payload.cleanupError;
        else delete errors[record.id];
        await tx.setEntry(this.indexes, key, JSON.stringify(errors));
    }
    async invalidate(tx: ISeqFileTransaction): Promise<void> {await tx.deleteEntry(this.indexes, 'view-health/ready-v1');}
    private async rebuild(tx: ISeqFileTransaction): Promise<void> {
        const pages = new TwinSeqPages(this.indexes), count = await pages.count(tx, 'job'), errors: Record<string, string> = {};
        for (let offset = 0; offset < count; offset += 100) for (const id of await pages.list(tx, 'job', offset, 100)) {
            const encoded = encodeURIComponent(id), revision = await tx.getEntry(this.knowledge, 'head/job/' + encoded);
            const raw = revision && await tx.getEntry(this.knowledge, `version/job/${encoded}/${encodeURIComponent(revision)}`);
            if (!raw) throw new Error('TWIN_JOB_INDEX_INCONSISTENT');
            const row = JSON.parse(raw) as TwinRecord;
            if (row.payload.cleanupError && !row.payload.cleaned) errors[id] = String(row.payload.cleanupError);
        }
        await tx.setEntry(this.indexes, key, JSON.stringify(errors));
        await tx.setEntry(this.indexes, 'view-health/ready-v1', '1');
    }
}

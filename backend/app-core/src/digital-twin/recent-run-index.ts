import {seqKeys} from '@nestos/vfs-core/seq';
import {randomUUID} from '@nestos/common';
import type {ISeqFileTransaction} from '@nestos/vfs-core';
import type {TwinRecord} from './contracts';
import {recordKey} from './codec';
import {TwinSeqPages} from './seq-pages';
const ready = 'recent-runs/ready-v1';
const key = (id: string) => 'recent-runs/plan/' + encodeURIComponent(id);

/** Rebuildable projection, committed with the authoritative run and invalidated with forgetting. */
export class RecentRunIndex {
    constructor(private readonly indexPath: string, private readonly knowledgePath: string) {}
    async read(tx: ISeqFileTransaction, planIds: string[]): Promise<TwinRecord[]> {
        if (!await tx.getEntry(this.indexPath, ready)) await this.rebuild(tx);
        const rows = await Promise.all(planIds.map(async id => JSON.parse(await tx.getEntry(this.indexPath, key(id)) ?? '[]') as TwinRecord[]));
        return rows.flat();
    }
    async put(tx: ISeqFileTransaction, record: TwinRecord): Promise<void> {
        if (record.family !== 'scan-run') return;
        const id = String(record.payload.planId), path = key(id);
        const rows = JSON.parse(await tx.getEntry(this.indexPath, path) ?? '[]') as TwinRecord[];
        const next = [...rows.filter(row => row.id !== record.id), summarize(record)]
            .sort((a, b) => Number(b.payload.createdAt) - Number(a.payload.createdAt) || b.id.localeCompare(a.id)).slice(0, 5);
        await tx.setEntry(this.indexPath, path, JSON.stringify(next));
    }
    async invalidate(tx: ISeqFileTransaction): Promise<void> {await tx.deleteEntry(this.indexPath, ready);}
    private async rebuild(tx: ISeqFileTransaction): Promise<void> {
        const started = Date.now(), pages = new TwinSeqPages(this.indexPath), groups = new Map<string, TwinRecord[]>();
        const total = await pages.count(tx, 'scan-run');
        for (let offset = 0; offset < total; offset += 100) for (const id of await pages.list(tx, 'scan-run', offset, 100, true)) {
            const ref = {family: 'scan-run' as const, id}, revision = await tx.getEntry(this.knowledgePath, 'head/' + recordKey(ref));
            const raw = revision && await tx.getEntry(this.knowledgePath, `version/${recordKey(ref)}/${encodeURIComponent(revision)}`);
            if (!raw) throw new Error('TWIN_RECENT_RUN_INDEX_INCONSISTENT');
            const row = JSON.parse(raw) as TwinRecord, group = String(row.payload.planId), selected = groups.get(group) ?? [];
            selected.push(summarize(row)); selected.sort((a, b) => Number(b.payload.createdAt) - Number(a.payload.createdAt));
            groups.set(group, selected.slice(0, 5));
        }
        for await (const name of seqKeys(tx,this.indexPath,'recent-runs/plan/')) await tx.deleteEntry(this.indexPath,name);
        for (const [id, rows] of groups) await tx.setEntry(this.indexPath, key(id), JSON.stringify(rows));
        await tx.setEntry(this.indexPath, 'recent-runs/groups', JSON.stringify([...groups.keys()]));
        await tx.setEntry(this.indexPath, ready, '1');
        console.info('[DigitalTwinView]', {operation: 'twin.recentRuns.rebuild', operationId: randomUUID(), stage: 'projection', result: 'success', count: total, durationMs: Date.now() - started});
    }
}
function summarize(row: TwinRecord): TwinRecord {
    const data = row.payload;
    const collection = data.collection as Record<string, unknown> | undefined;
    return {...row, payload: {...data, sourceCount: (data.sourceIds as string[]).length, completedSourceCount: (data.completedSourceIds as string[]).length,
        sourceIds: [], completedSourceIds: [], ...(collection ? {collection: Object.fromEntries(Object.entries(collection).filter(([name]) => name !== 'values'))} : {})}};
}

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IFileSystem, type ISeqFileTransaction } from '@nestos/vfs-core';
import { IndexedDBBackend } from '@nestos/vfsdriver-indexeddb';
import { SeqTwinStore } from '../src/digital-twin/seq-twin-store';
import type { TwinCommit } from '../src/digital-twin/contracts';

const memory = { family: 'memory' as const, id: 'person/name' };
const evidence = { family: 'evidence' as const, id: 'source#1' };
const releases: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of releases.splice(0)) await release(); });

async function setup(kind: 'memory' | 'indexeddb') {
    const backend = kind === 'memory' ? new MemoryBackend()
        : new IndexedDBBackend({ dbName: `twin-test-${crypto.randomUUID()}` });
    const { manager } = await createVFS({ rootBackend: backend });
    releases.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    return { fs, store: await SeqTwinStore.open(fs, 'test', 'owner') };
}

function commit(operationId = 'extract', expectedForgetEpoch = 0): TwinCommit {
    return { operationId, expectedForgetEpoch, writes: [
        { ...memory, expectedRevision: null, payload: { content: 'Candidate', state: 'pending' } },
        { ...evidence, expectedRevision: null, payload: { locator: 'message-1' } },
    ] };
}

describe.each(['memory', 'indexeddb'] as const)('SeqTwinStore on %s', kind => {
    it('reopens the same owner binding and rejects another owner', async () => {
        const { fs, store } = await setup(kind);
        const first = await store.inspect();
        expect(await (await SeqTwinStore.open(fs, 'test', 'owner')).inspect()).toEqual(first);
        await expect(SeqTwinStore.open(fs, 'test', 'other')).rejects.toThrow('owner denied');
        await expect(SeqTwinStore.open(fs, '../escape', 'owner')).rejects.toThrow('path identity');
    });

    it('keeps a single worker lease and rejects stale fences without accumulating receipts', async () => {
        const {fs, store} = await setup(kind);
        const ref = {family: 'checkpoint' as const, id: 'scan-worker'};
        const lease = {owner: 'worker', host: 'local', until: 100, fence: 1};
        await store.replaceScanLease(lease, null);
        const first = (await store.read(ref))!;
        await store.replaceScanLease({...lease, until: 0}, first.revision);
        await expect(store.replaceScanLease(lease, first.revision)).rejects.toThrow('revision conflict');
        expect((await store.read(ref))?.payload.until).toBe(0);
        const seq = fs.meta.seq!, root = '/var/lib/digital-twin/test';
        expect(await seq.getEntry(root + '/knowledge.seq', 'version/checkpoint/scan-worker/' + first.revision)).toBeNull();
        const receipts: string[] = [];
        await seq.walkEntries(root + '/processing.seq', row => { receipts.push(row.key); return true; });
        expect(receipts).toEqual([]);
    });

    it('preserves source order, historical anchors, recent counts and forgetting across compaction', async () => {
        const {fs, store} = await setup(kind), seq = fs.meta.seq!;
        const ref = {family: 'scan-run' as const, id: 'r'}, root = '/var/lib/digital-twin/test';
        const sources = Array.from({length: 50}, (_, i) => 'source-' + i);
        let revision: string | null = null;
        const revisions: string[] = [];
        for (const [i, ids] of [sources, sources, sources, sources.slice().reverse()].entries()) {
            const receipt = await store.commit({operationId: 'step-' + i, expectedForgetEpoch: 0, writes: [
                {...ref, expectedRevision: revision, payload: {sourceIds: ids, planId: 'p', completedSourceIds: [], createdAt: 1}}]});
            revision = receipt.versions[0].revision; revisions.push(revision);
            const key = 'version/scan-run/r/' + revision;
            if (i === 1) {
                const row = JSON.parse((await seq.getEntry(root + '/knowledge.seq', key))!);
                expect(row.sourceListRevision).toBe(revisions[0]);
                delete row.sourceListRevision; delete row.sourceCount; row.payload.sourceIds = ids;
                await seq.setEntry(root + '/knowledge.seq', key, JSON.stringify(row));
            }
            expect((await store.read(ref))?.payload.sourceIds).toEqual(ids);
            expect((await store.list('scan-run'))[0].payload.sourceIds).toEqual(ids);
        }
        expect(await store.compactScanRun('r')).toBe(2);
        expect(await store.compactScanRun('r')).toBe(0);
        await seq.deleteEntry(root + '/indexes.seq', 'recent-runs/ready-v1');
        expect((await store.recentRuns(['p']))[0].payload.sourceCount).toBe(50);
        await store.startForget({operationId: 'forget-run', expectedForgetEpoch: 0, records: [ref]});
        await store.cleanBatch('forget-run', 4);
        for (const rev of revisions) expect(await seq.getEntry(root + '/knowledge.seq', 'version/scan-run/r/' + rev)).toBeNull();
    });

    it('commits linked records across files and replays the original receipt', async () => {
        const { fs, store } = await setup(kind);
        const first = await store.commit(commit());
        const reopened = await SeqTwinStore.open(fs, 'test', 'owner');
        expect(await reopened.commit(commit())).toEqual(first);
        expect(await reopened.read(memory)).toMatchObject({ ...memory, revision: first.versions[0].revision });
        expect(await reopened.read(evidence)).toMatchObject(evidence);
        const changed = commit(); changed.writes[0].payload.content = 'Changed';
        await expect(reopened.commit(changed)).rejects.toThrow('operation identity conflict');
    });

    it('rolls back the whole transaction after a write and retries without a phantom receipt', async () => {
        const { fs, store } = await setup(kind);
        const faulty = await SeqTwinStore.open(failAfterWrite(fs), 'test', 'owner');
        await expect(faulty.commit(commit())).rejects.toThrow('Injected transaction failure');
        expect(await store.read(memory)).toBeNull();
        expect(await store.read(evidence)).toBeNull();
        expect(await fs.meta.seq!.getEntry('/var/lib/digital-twin/test/indexes.seq', 'family/memory/person%2Fname')).toBeNull();
        expect((await store.commit(commit())).versions).toHaveLength(2);
    });

    it('rejects stale revisions without committing the other record in a batch', async () => {
        const { store } = await setup(kind);
        await store.commit(commit());
        const stale = commit('stale');
        stale.writes[1] = { family: 'goal', id: 'new', expectedRevision: null, payload: { content: 'Not committed' } };
        await expect(store.commit(stale)).rejects.toThrow('revision conflict');
        expect(await store.read({ family: 'goal', id: 'new' })).toBeNull();
    });

    it('allows exactly one concurrent CAS correction', async () => {
        const { fs, store } = await setup(kind);
        const other = await SeqTwinStore.open(fs, 'test', 'owner');
        const receipt = await store.commit(commit());
        const results = await Promise.allSettled([store, other].map((writer, i) => writer.commit({
            operationId: `correct-${i}`, expectedForgetEpoch: 0, writes: [{ ...memory,
                expectedRevision: receipt.versions[0].revision, payload: { content: `Correction ${i}` } }],
        })));
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    });

    it('invalidates immediately, cleans all versions after reopening and blocks resurrection', async () => {
        const { fs, store } = await setup(kind);
        const first = await store.commit(commit());
        await store.commit({ operationId: 'correct', expectedForgetEpoch: 0, writes: [{ ...memory,
            expectedRevision: first.versions[0].revision, payload: { content: 'Corrected' } }] });
        const command = { operationId: 'forget', expectedForgetEpoch: 0, records: [memory] };
        expect((await store.startForget(command)).state).toBe('invalidated');
        expect(await store.read(memory)).toBeNull();
        expect(await store.read(evidence)).not.toBeNull();
        expect(await store.commit(commit())).toEqual(first);
        expect(await store.read(memory)).toBeNull();
        const reopened = await SeqTwinStore.open(fs, 'test', 'owner');
        expect((await reopened.cleanBatch('forget', 1)).state).toBe('cleaning');
        expect((await reopened.cleanBatch('forget', 1)).state).toBe('completed');
        expect((await reopened.startForget(command)).state).toBe('completed');
        const fresh = commit('revive', 1); fresh.writes = [fresh.writes[0]];
        await expect(reopened.commit(fresh)).rejects.toThrow('record forgotten');
        expect(await fs.meta.seq!.getEntry('/var/lib/digital-twin/test/knowledge.seq',
            `version/memory/person%2Fname/${first.versions[0].revision}`)).toBeNull();
        expect(await fs.meta.seq!.getEntry('/var/lib/digital-twin/test/indexes.seq', 'family/memory/person%2Fname')).toBeNull();
    });

    it('rejects old work after an epoch change and does not leak partial cleanup on rollback', async () => {
        const { fs, store } = await setup(kind);
        await store.commit(commit());
        await store.startForget({ operationId: 'forget', expectedForgetEpoch: 0, records: [memory, evidence] });
        const stale = commit('late'); stale.writes = [{ family: 'goal', id: 'new', expectedRevision: null, payload: {} }];
        await expect(store.commit(stale)).rejects.toThrow('epoch conflict');
        const faulty = await SeqTwinStore.open(failAfterWrite(fs), 'test', 'owner');
        await expect(faulty.cleanBatch('forget', 100)).rejects.toThrow('Injected transaction failure');
        expect((await store.startForget({ operationId: 'forget', expectedForgetEpoch: 0,
            records: [memory, evidence] })).state).toBe('invalidated');
        expect((await store.cleanBatch('forget', 100)).state).toBe('completed');
    });

    it('fails closed for unknown schema and stale incarnation', async () => {
        const { fs, store } = await setup(kind);
        const current = await store.inspect();
        await fs.meta.seq!.setEntry('/var/lib/digital-twin/test/authority.seq', 'twin',
            JSON.stringify({ ...current, schemaVersion: 2 }));
        await expect(store.inspect()).rejects.toThrow('Unsupported Twin schema');
        await fs.meta.seq!.setEntry('/var/lib/digital-twin/test/authority.seq', 'twin',
            JSON.stringify({ ...current, incarnation: 'replacement' }));
        await expect(store.read(memory)).rejects.toThrow('binding expired');
    });

    it('isolates Twin identities and validates batches before persistence', async () => {
        const { fs, store } = await setup(kind);
        await store.commit(commit());
        const other = await SeqTwinStore.open(fs, 'another', 'owner');
        expect(await other.read(memory)).toBeNull();
        const duplicate = commit('duplicate'); duplicate.writes.push(duplicate.writes[0]);
        await expect(store.commit(duplicate)).rejects.toThrow('Duplicate Twin record');
        await expect(store.commit({ ...commit('bad'), writes: [{ ...memory, expectedRevision: null,
            payload: { lost: undefined } }] })).rejects.toThrow('Invalid Twin JSON');
    });

    it('does not reinitialize surviving records after authority metadata is lost', async () => {
        const { fs, store } = await setup(kind);
        await store.commit(commit());
        await fs.meta.seq!.deleteEntry('/var/lib/digital-twin/test/authority.seq', 'twin');
        await expect(SeqTwinStore.open(fs, 'test', 'owner')).rejects.toThrow('metadata missing');
        await expect(store.read(memory)).rejects.toThrow('not initialized');
    });

    it('rejects broken version pointers rather than reporting an ordinary empty result', async () => {
        const { fs, store } = await setup(kind);
        const receipt = await store.commit(commit());
        await fs.meta.seq!.deleteEntry('/var/lib/digital-twin/test/knowledge.seq',
            `version/memory/person%2Fname/${receipt.versions[0].revision}`);
        await expect(store.read(memory)).rejects.toThrow('version missing');
    });
});

function failAfterWrite(fs: IFileSystem): IFileSystem {
    const seq = fs.meta.seq!;
    return new Proxy(fs, { get(target, property, receiver) {
        if (property !== 'meta') return Reflect.get(target, property, receiver);
        return { ...target.meta, seq: { ...seq, transaction: <T>(run: (tx: ISeqFileTransaction) => Promise<T>) =>
            seq.transaction!(tx => run(new Proxy(tx, { get(transaction, key) {
                const method = Reflect.get(transaction, key);
                if (key === 'setEntry' || key === 'deleteEntry') return async (...args: unknown[]) => {
                    await method.apply(transaction, args);
                    throw new Error('Injected transaction failure');
                };
                return typeof method === 'function' ? method.bind(transaction) : method;
            } }))) } };
    } });
}

// This compatibility scenario seeds 250 rows and 105 committed revisions on the IndexedDB driver.
it('bounds actual IndexedDB prefix batches across multiple index pages and cleans version chains without prefix materialization', async () => {
    const { fs, store } = await setup('indexeddb');
    for (let page = 0; page < 3; page++) await store.commit({ operationId: `page-${page}`, expectedForgetEpoch: 0,
        writes: Array.from({ length: page === 2 ? 50 : 100 }, (_, index) => ({ family: 'memory', id: `item-${page * 100 + index}`,
            expectedRevision: null, payload: { content: 'indexed row' } })) });
    const ref = { family: 'memory' as const, id: 'item-0' };
    let current = (await store.read(ref))!;
    for (let index = 0; index < 105; index++) {
        await store.commit({ operationId: `version-${index}`, expectedForgetEpoch: 0,
            writes: [{ ...ref, expectedRevision: current.revision, payload: { content: `version-${index}` } }] });
        current = (await store.read(ref))!;
    }
    const sizes: number[] = [], original = IDBObjectStore.prototype.getAll;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function(this: IDBObjectStore, ...args: any[]) {
        const request = original.apply(this, args as any);
        request.addEventListener('success', () => { sizes.push(request.result.length); });
        return request;
    });
    try {
        expect(await store.list('memory', { offset: 95, limit: 100 })).toHaveLength(100);
        await store.startForget({ operationId: 'forget-chain', expectedForgetEpoch: 0, records: [ref] });
        expect(await store.pendingCleanup()).toHaveLength(1);
        expect((await store.cleanBatch('forget-chain', 100)).state).toBe('cleaning');
        expect((await store.cleanBatch('forget-chain', 100)).state).toBe('completed');
        expect(await store.pendingCleanup()).toEqual([]);
        expect(await store.list('memory', { offset: 0, limit: 100 })).toHaveLength(100);
        expect(await store.list('memory', { offset: 200, limit: 100 })).toHaveLength(49);
        expect(sizes.length).toBeGreaterThan(0); expect(Math.max(...sizes)).toBeLessThanOrEqual(100);
        expect(await fs.meta.seq!.getEntry('/var/lib/digital-twin/test/knowledge.seq', `version/memory/item-0/${current.revision}`)).toBeNull();
    } finally { spy.mockRestore(); }
}, 15_000);

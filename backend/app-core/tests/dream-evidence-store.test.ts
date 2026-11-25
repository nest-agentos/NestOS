import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import type {SourceScanResult} from '@nestos/dream';
import {DreamEvidenceStore} from '../src/dream/evidence-store';

const authority = {principalId: 'user', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'remote'};
const receipt = {scanRunId: 'scan', sessionId: 'session', taskId: 'task'};
const batch = (startCursor: string | null, endCursor: string): SourceScanResult<string> => ({status: 'ok', items: ['private'],
    evidence: {sourceId: 'source', projectId: 'remote-project', connectionId: 'connection', authority,
        startCursor, endCursor, version: 'v1', scanned: 1}});

it('pages committed history without duplicating retries or recording rolled back attempts', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const failed = [{status: 'failed' as const, sourceId: 'source', code: 'READ_FAILED' as const}];
        for (let index = 0; index < 23; index++) await store.commit('owner', 'dream', `run-${index}`, failed);
        await store.commit('owner', 'dream', 'run-22', failed);
        const first = await store.history('owner', 'dream');
        expect(first.scanned).toBe(20); expect(first.items[0].operationId).toBe('run-22');
        const second = await store.history('owner', 'dream', first.nextCursor);
        expect(second.scanned).toBe(3); expect(second.items.map(item => item.operationId)).toEqual(['run-2', 'run-1', 'run-0']);
        expect(second.nextCursor).toBeUndefined();
    } finally {await manager.dispose();}
});

it('atomically persists a source watermark and idempotent metadata receipt without source content', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), first = new DreamEvidenceStore(fs), second = new DreamEvidenceStore(fs);
        const outcomes: SourceScanResult<string>[] = [batch(null, 'one'), {status: 'failed', sourceId: 'denied', code: 'AUTHORIZATION_FAILED'}];
        await first.settle('owner', 'dream', 'run-1', outcomes, [], receipt);
        await second.settle('owner', 'dream', 'run-1', outcomes, [], receipt);
        const run = await second.run('owner', 'dream', 'run-1');
        expect(run?.outcomes).toHaveLength(2);
        expect(JSON.stringify(run)).not.toContain('private');
        expect(await second.run('other', 'dream', 'run-1')).toBeNull();
        await expect(first.settle('owner', 'dream', 'run-1', [batch(null, 'different')], [], receipt)).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        await expect(first.settle('owner', 'dream', 'run-2', [batch(null, 'stale')], [], receipt)).rejects.toThrow('DREAM_WATERMARK_CONFLICT');
        expect(await first.run('owner', 'dream', 'run-2')).toBeNull();
        await second.settle('owner', 'dream', 'run-3', [batch('one', 'two')], [], receipt);
        expect(await first.run('owner', 'dream', 'run-3')).not.toBeNull();
    } finally {await manager.dispose();}
});

it('rejects concurrent stale source scans without recording a losing receipt', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const results = await Promise.allSettled([store.settle('owner', 'dream', 'a', [batch(null, 'a')], [], receipt),
            store.settle('owner', 'dream', 'b', [batch(null, 'b')], [], receipt)]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
        expect([await store.run('owner', 'dream', 'a'), await store.run('owner', 'dream', 'b')].filter(Boolean)).toHaveLength(1);
    } finally {await manager.dispose();}
});

it('rolls back earlier watermarks when another source in the same run conflicts', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const other = batch(null, 'first');
        if (other.status !== 'ok') throw new Error('fixture');
        other.evidence.sourceId = 'other';
        await store.settle('owner', 'dream', 'prior', [other], [], receipt);
        await expect(store.settle('owner', 'dream', 'conflict', [batch(null, 'new'), other],
            [{id: 'finding', sourceId: 'source', kind: 'fact', content: 'derived'}], receipt)).rejects.toThrow('DREAM_WATERMARK_CONFLICT');
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        expect(await fs.meta.seq!.getEntry(path, 'finding:"finding"')).toBeNull();
        await store.settle('owner', 'dream', 'retry', [batch(null, 'new')], [], receipt);
        expect(await store.run('owner', 'dream', 'conflict')).toBeNull();
    } finally {await manager.dispose();}
});

it('commits derived findings with the watermark and rejects changed findings on retry', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const findings = [{id: 'f1', sourceId: 'source', kind: 'fact' as const, content: 'A finding'}];
        await expect(store.commit('owner', 'dream', 'run', [batch(null, 'one')])).rejects.toThrow('DREAM_SETTLEMENT_REQUIRED');
        await expect(store.settle('owner', 'dream', 'run', [batch(null, 'one')], findings)).rejects.toThrow('DREAM_RECEIPT_REQUIRED');
        await store.settle('owner', 'dream', 'run', [batch(null, 'one')], findings, receipt);
        await store.settle('owner', 'dream', 'run', [batch(null, 'one')], findings, receipt);
        const raw = await fs.meta.seq!.getEntry('/var/lib/projects/owner/dream/dream/evidence.seq', 'finding:"f1"');
        expect(JSON.parse(raw!)).toEqual(findings[0]);
        await expect(store.settle('owner', 'dream', 'run', [batch(null, 'one')], [{...findings[0], content: 'changed'}], receipt))
            .rejects.toThrow('DREAM_OPERATION_CONFLICT');
    } finally {await manager.dispose();}
});

it('rolls back a failed transaction and retries the same operation without a duplicate', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs), seq = fs.meta.seq!;
        const faulty = new DreamEvidenceStore({driver: fs.driver, meta: {seq: {transaction: async (work: Parameters<NonNullable<typeof seq.transaction>>[0]) =>
            seq.transaction!(async tx => work({getEntry: tx.getEntry.bind(tx), setEntry: async (path: string, key: string, value: string) => {
                if (key.startsWith('run:')) throw new Error('injected write failure');
                return tx.setEntry(path, key, value);
            }} as typeof tx))}}} as never);
        const records = [{id: 'f1', sourceId: 'source', kind: 'fact' as const, content: 'derived'}];
        await expect(faulty.settle('owner', 'dream', 'run', [batch(null, 'one')], records, receipt)).rejects.toThrow('injected write failure');
        expect(await store.run('owner', 'dream', 'run')).toBeNull();
        expect(await store.finding('owner', 'dream', 'f1')).toBeNull();
        const brokenIndex = new DreamEvidenceStore({driver: fs.driver, meta: {seq: {transaction: async (work: Parameters<NonNullable<typeof seq.transaction>>[0]) =>
            seq.transaction!(async tx => work({getEntry: tx.getEntry.bind(tx), increment: tx.increment.bind(tx), setEntry: async (path: string, key: string, value: string) => {
                if (key.startsWith('run-order:')) throw new Error('injected index failure');
                return tx.setEntry(path, key, value);
            }} as typeof tx))}}} as never);
        await expect(brokenIndex.settle('owner', 'dream', 'run', [batch(null, 'one')], records, receipt)).rejects.toThrow('injected index failure');
        expect(await store.run('owner', 'dream', 'run')).toBeNull();
        expect(await store.history('owner', 'dream')).toEqual({items: [], scanned: 0});
        await store.settle('owner', 'dream', 'run', [batch(null, 'one')], records, receipt);
        await store.settle('owner', 'dream', 'run', [batch(null, 'one')], records, receipt);
        expect(await store.finding('owner', 'dream', 'f1')).toMatchObject(records[0]);
    } finally {await manager.dispose();}
});

import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/common';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from '../src/dream/evidence-store';
import {DreamRecompute} from '../src/dream/recompute';
import {DreamHost} from '../src/dream/host';

it('persists a stable request before execution, retries failures and reuses it after reopening', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.meta.seq!.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        const sources = [{sourceId: 'source-b', operationId: 'capture-b'}];
        const id = 'recompute-' + sha256HexSync(JSON.stringify(['owner', 'dream', 'B', 1, 'version', sources]));
        const plan = {owner: 'owner', dream: 'dream', project: 'B', configRevision: 1, activeVersion: 'version', sources, id};
        const executeRecomputation = vi.fn().mockRejectedValueOnce(new Error('DREAM_CONSOLIDATION_FAILED')).mockResolvedValue(undefined);
        const host = {planRecomputation: vi.fn(async () => [plan]), executeRecomputation};
        let now = 10000;
        const worker = new DreamRecompute(fs, host, () => now);
        await worker.noteChange(); await worker.noteChange(); await worker.scan();
        const key = `recompute-request:${JSON.stringify(id)}`;
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, key))!).state).toBe('pending');
        await worker.scan(); expect(executeRecomputation).toHaveBeenCalledOnce();
        await worker.quiesce();
        now += 1000;
        const reopened = new DreamRecompute(fs, host, () => now); await reopened.scan();
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, key))!).state).toBe('done');
        await reopened.scan(); await reopened.noteChange(); await reopened.scan();
        expect(executeRecomputation).toHaveBeenCalledTimes(2);
        expect(executeRecomputation.mock.calls.map(call => call[0].id)).toEqual([id, id]);
        await reopened.quiesce();
    } finally {await manager.dispose();}
});

it('plans independent remaining-source recomputation for a revoked pending proposal with no active version', async () => {
    const host = Object.create(DreamHost.prototype) as any;
    host.options = {authorizeOwner: async () => {}};
    host.configs = {read: async () => ({revision: 1, config: {enabled: true, consolidation: {target: {}},
        files: [{id: 'a', projectId: 'A'}, {id: 'b', projectId: 'B'}]}})};
    host.evidence = {activeMemoryScopes: async () => null, pendingMemoryScopes: async () => [['a', 'b']],
        watermark: async () => ({}),
        latestCapturedOperation: async (_owner: string, _dream: string, id: string) => `capture-${id}`,
        readCapturedOperation: async (_owner: string, _dream: string, _operation: string, authorize: (item: unknown) => Promise<unknown>) => {
            const evidence = {sourceId: 'b', projectId: 'B', snapshot: 'proof', fingerprint: sha256HexSync('proof')}; await authorize(evidence); return evidence;
        }, checkConfig: async () => {}};
    host.authorizeConsolidationSource = async (_owner: string, _dream: string, _revision: number, source: string) => {
        if (source === 'a') throw new Error('DREAM_AUTHORIZATION_CHANGED'); return {};
    };
    const plans = await host.planRecomputation('owner', 'dream');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({project: 'B', activeVersion: null, sources: [{sourceId: 'b', operationId: 'capture-b'}]});
    host.authorizeConsolidationSource = async () => {throw new Error('NETWORK_UNAVAILABLE');};
    await expect(host.planRecomputation('owner', 'dream')).rejects.toThrow('NETWORK_UNAVAILABLE');
});

it('accepts a currently authorized grant revision only for the same captured source identity', async () => {
    const host = Object.create(DreamHost.prototype) as any;
    const captured = {principalId: 'alice', revision: 'old', projectRevision: '1', serverId: 'server', serverProjectId: 'B'};
    let current = {...captured, revision: 'new', projectRevision: '2'};
    host.options = {authorizeOwner: async () => {}};
    host.configs = {read: async () => ({revision: 1, config: {enabled: true,
        files: [{id: 'b', projectId: 'B', connectionId: 'c', capability: 'fileRead'}]}})};
    host.evidence = {watermark: async () => ({projectId: 'B', connectionId: 'c', authority: captured}), checkConfig: async () => {}};
    host.sourceAuthorization = {authorizeDreamSource: async () => current};
    expect(await host.authorizeConsolidationSource('owner', 'dream', 1, 'b')).toEqual(captured);
    current = {...current, principalId: 'mallory'};
    await expect(host.authorizeConsolidationSource('owner', 'dream', 1, 'b')).rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
    current = {...captured, revision: 'new', serverId: 'other-server'};
    await expect(host.authorizeConsolidationSource('owner', 'dream', 1, 'b')).rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
    host.sourceAuthorization.authorizeDreamSource = async () => {throw new Error('DREAM_AUTHORIZATION_DENIED');};
    await expect(host.authorizeConsolidationSource('owner', 'dream', 1, 'b')).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
});

it('uses a new attempt only when frozen pending context conflicts', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.meta.seq!.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        const sources = [{sourceId: 'b', operationId: 'capture'}], activeVersion = null;
        const id = 'recompute-' + sha256HexSync(JSON.stringify(['owner', 'dream', 'B', 1, activeVersion, sources]));
        const plan = {owner: 'owner', dream: 'dream', project: 'B', configRevision: 1, activeVersion, sources, id};
        const executeRecomputation = vi.fn().mockRejectedValueOnce(new Error('DREAM_OPERATION_CONFLICT')).mockResolvedValue(undefined);
        let now = 10000;
        const worker = new DreamRecompute(fs, {planRecomputation: async () => [plan], executeRecomputation}, () => now);
        await worker.scan(); now += 1000; await worker.scan();
        expect(executeRecomputation.mock.calls.map(call => call[1])).toEqual([0, 1]);
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, `recompute-request:${JSON.stringify(id)}`))!).state).toBe('done');
        await worker.quiesce();
    } finally {await manager.dispose();}
});

it('backfills a missing discovery index in the background', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        const sources = [{sourceId: 'b', operationId: 'capture'}], activeVersion = null;
        const id = 'recompute-' + sha256HexSync(JSON.stringify(['owner', 'dream', 'B', 1, activeVersion, sources]));
        const plan = {owner: 'owner', dream: 'dream', project: 'B', configRevision: 1, activeVersion, sources, id};
        const executeRecomputation = vi.fn(async () => {});
        const worker = new DreamRecompute(fs, {recomputeCatalog: async () => ({items: [{owner: 'owner', dream: 'dream'}]}),
            planRecomputation: async () => [plan], executeRecomputation});
        expect(await fs.driver.exists(DREAM_OUTBOX_INDEX)).toBe(false);
        await worker.scan();
        expect(await fs.driver.exists(DREAM_OUTBOX_INDEX)).toBe(true);
        expect(executeRecomputation).toHaveBeenCalledOnce();
        await worker.quiesce();
    } finally {await manager.dispose();}
});

it('drains an in-flight authorization-change notification before shutdown', async () => {
    let release!: (exists: boolean) => void, finished = false;
    const gate = new Promise<boolean>(resolve => {release = resolve;});
    const fs = {driver: {exists: () => gate}, meta: {seq: {transaction: async (fn: any) => fn({increment: async () => 1})}}};
    const worker = new DreamRecompute(fs as never, {planRecomputation: async () => [], executeRecomputation: async () => {}});
    const note = worker.noteChange(), shutdown = worker.quiesce().then(() => {finished = true;});
    await Promise.resolve(); expect(finished).toBe(false);
    release(true); await note; await shutdown; expect(finished).toBe(true);
});

it('supersedes a queued request if its authorization situation has changed', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.meta.seq!.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        const sources = [{sourceId: 'b', operationId: 'capture'}], activeVersion = null;
        const id = 'recompute-' + sha256HexSync(JSON.stringify(['owner', 'dream', 'B', 1, activeVersion, sources]));
        const plan = {owner: 'owner', dream: 'dream', project: 'B', configRevision: 1, activeVersion, sources, id};
        const executeRecomputation = vi.fn(async () => {}), planRecomputation = vi.fn().mockResolvedValueOnce([plan]).mockResolvedValue([]);
        const worker = new DreamRecompute(fs, {planRecomputation, executeRecomputation}); await worker.scan();
        expect(JSON.parse((await fs.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, `recompute-request:${JSON.stringify(id)}`))!).state).toBe('superseded');
        expect(executeRecomputation).not.toHaveBeenCalled(); await worker.quiesce();
    } finally {await manager.dispose();}
});

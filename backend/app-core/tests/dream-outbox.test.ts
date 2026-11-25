import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {MemoryCommitStore} from '@nestos/dream/vfs';
import {DreamOutbox} from '../src/dream/outbox';
import {DreamDownstream} from '../src/dream/downstream';
import {DREAM_OUTBOX_INDEX, dreamOutboxKey} from '../src/dream/evidence-store';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {vi} from 'vitest';

it('ignores a configured Dream that has not created an evidence store yet', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.meta.seq!.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        const worker = new DreamOutbox(fs); await worker.scan(); await worker.quiesce();
    } finally {await manager.dispose();}
});

it('recovers committed events and transfers each consumer reference once after replay', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        await fs.driver.createFile({parentPath: '/var/lib/projects/owner/dream/dream', name: 'evidence.seq', type: 'seqfile', recursive: true});
        const store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), path);
        await store.stage({version: 'v1', parentVersion: null, requiredScopes: ['source'], topics: [{id: 'memory', content: 'committed'}]});
        await store.commit('commit1', 'v1', null, async tx => {
            await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        });
        expect((await store.active(async () => {}))?.version).toBe('v1');
        expect((await store.pending('daily', 0, 10)).items).toHaveLength(1);
        const restarted = new DreamOutbox(fs);
        await restarted.scan();
        const read = (consumer: string) => fs.meta.seq!.getEntry(path, `consumer-inbox:${consumer}:${JSON.stringify('commit1')}`);
        const daily = await read('daily'), kanban = await read('kanban');
        expect(JSON.parse(daily!)).toMatchObject({commitId: 'commit1', version: 'v1', requiredScopes: ['source']});
        expect(kanban).toBe(daily);
        await fs.meta.seq!.transaction!(tx => tx.deleteEntry(path, `outbox-delivered:${JSON.stringify(JSON.stringify(['daily', 'commit1']))}`));
        await restarted.quiesce();
        const replay = new DreamOutbox(fs);
        await replay.scan();
        expect(await read('daily')).toBe(daily);
        expect((await store.pending('daily', 0, 10)).items).toHaveLength(0);
        expect((await store.pending('kanban', 0, 10)).items).toHaveLength(0);
        await replay.quiesce();
    } finally {await manager.dispose();}
});

it('starts delivery from the host background lifecycle after runtime restart', async () => {
    const backend = new MemoryBackend(); await backend.init();
    const close = backend.close.bind(backend); backend.close = async () => {};
    const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    let runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
    const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
    try {
        let fs = await runtime.vfs.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        await fs.driver.createFile({parentPath: '/var/lib/projects/owner/dream/dream', name: 'evidence.seq', type: 'seqfile', recursive: true});
        let store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), path);
        await store.stage({version: 'v1', parentVersion: null, requiredScopes: ['source'], topics: [{id: 'memory', content: 'committed'}]});
        await store.commit('commit1', 'v1', null, async tx => {
            await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));
        });
        await runtime.dispose();
        runtime = await createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false, remoteSourceProvider});
        fs = await runtime.vfs.openFileSystem('/');
        store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), path);
        await vi.waitFor(async () => expect((await store.pending('daily', 0, 10)).items).toHaveLength(0), {timeout: 15000, interval: 100});
        expect((await store.active(async () => {}))?.version).toBe('v1');
        await vi.waitFor(async () => expect((await store.pending('kanban', 0, 10)).items).toHaveLength(0), {timeout: 15000, interval: 100});
    } finally {await runtime.dispose(); await close();}
}, 60000);

it('persists committed differences once and filters downstream reads after revocation', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/var/lib/dream', name: 'outbox-index.seq', type: 'seqfile', recursive: true});
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        await fs.driver.createFile({parentPath: '/var/lib/projects/owner/dream/dream', name: 'evidence.seq', type: 'seqfile', recursive: true});
        const store = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), path);
        await store.stage({version: 'v1', parentVersion: null, requiredScopes: ['a', 'b'], topics: [{id: 'old', content: 'old'}]});
        await store.commit('commit1', 'v1', null, async tx => {await tx.setEntry(DREAM_OUTBOX_INDEX, dreamOutboxKey('owner', 'dream'), JSON.stringify({owner: 'owner', dream: 'dream'}));});
        await store.stage({version: 'v2', parentVersion: 'v1', requiredScopes: ['a', 'b'], topics: [{id: 'old', content: 'new'}, {id: 'added', content: 'added'}]});
        await store.commit('commit2', 'v2', 'v1', async () => {});
        await fs.meta.seq!.setEntry(path, `review-receipt:${JSON.stringify(['commit2'])}`, JSON.stringify({selected: [{id: 'p', revision: 1}], expectedVersion: 'v1'}));
        await fs.meta.seq!.setEntry(path, `proposal-history:${JSON.stringify(['p', '1'])}`, JSON.stringify({id: 'p', revision: 1, evidenceIds: ['ev1'], requiredScopes: ['a', 'b'], changes: [{id: 'old'}, {id: 'added'}]}));
        let allowed = true;
        const authorize = async (_owner: string, _dream: string, scopes: readonly string[]) => {if (!allowed && scopes.includes('a')) throw new Error('DREAM_AUTHORIZATION_CHANGED');};
        const downstream = new DreamDownstream(fs, authorize), worker = new DreamOutbox(fs, downstream);
        await worker.scan();
        const daily = await downstream.read('owner', 'dream', 'daily', 'commit2');
        expect(daily?.changes).toEqual([{id: 'added', action: 'add', content: 'added', evidenceIds: ['ev1'], evidenceRefs: [{proposalId: 'p', evidenceId: 'ev1'}]},
            {id: 'old', action: 'update', content: 'new', evidenceIds: ['ev1'], evidenceRefs: [{proposalId: 'p', evidenceId: 'ev1'}]}]);
        expect(await downstream.read('owner', 'dream', 'kanban', 'commit2')).toEqual(daily);
        await worker.quiesce();
        const restarted = new DreamOutbox(fs, downstream); await restarted.scan();
        expect(await downstream.read('owner', 'dream', 'daily', 'commit2')).toEqual(daily);
        allowed = false;
        await expect(downstream.read('owner', 'dream', 'daily', 'commit2')).rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
        await expect(downstream.read('owner', 'dream', 'kanban', 'commit2')).rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
        expect((await downstream.list('owner', 'dream', 'daily')).items).toEqual([]);
        await store.stage({version: 'v3', parentVersion: 'v2', requiredScopes: ['a', 'b'], topics: []});
        await store.commit('commit3', 'v3', 'v2', async () => {});
        await restarted.scan();
        expect(await fs.meta.seq!.getEntry(path, `consumer-result:daily:${JSON.stringify('commit3')}`)).toBeNull();
        allowed = true; await restarted.scan();
        expect((await downstream.read('owner', 'dream', 'daily', 'commit3'))?.changes).toHaveLength(2);
        await restarted.quiesce();
    } finally {await manager.dispose();}
});

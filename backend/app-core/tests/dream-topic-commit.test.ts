import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, type ISeqFileTransaction} from '@nestos/vfs-core';
import {MemoryCommitStore, ProposalStore} from '@nestos/dream/vfs';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {DreamDownstream} from '../src/dream/downstream';

it('freezes topic metadata and update time across a failed staged commit, preserving legacy entries', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'seed', 'a'.repeat(64), 'source');
        const path = store.consolidationPath('owner', 'dream');
        await fs.driver.createFile({parentPath: '/var/lib/projects/owner/dream/dream', name: 'config.seq', type: 'seqfile'});
        await fs.meta.seq!.setEntry('/var/lib/projects/owner/dream/dream/config.seq', 'config', JSON.stringify({revision: 1}));
        const transaction = <T>(action: (tx: ISeqFileTransaction) => Promise<T>) => fs.meta.seq!.transaction!(action);
        const memory = new MemoryCommitStore(transaction, path), proposals = new ProposalStore(transaction, path);
        await memory.stage({version: 'v1', parentVersion: null, requiredScopes: ['source'], topics: [{id: 'legacy', content: 'Legacy rule'}]});
        await memory.commit('prior', 'v1', null, async () => {});
        await proposals.put({id: 'new', scope: 'owner', targetId: 'topic', revision: 1, status: 'ready', requiredScopes: ['source'],
            affectedMemoryIds: ['topic'], changes: [{id: 'topic', content: 'Detailed body', kind: 'topic', priority: 7, title: 'Design'}], evidenceIds: ['ev1']}, null);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
        const fail = vi.spyOn(MemoryCommitStore.prototype, 'stage').mockRejectedValueOnce(new Error('injected'));
        await expect(store.commitProposals('owner', 'dream', 'commit1', 'v1', [{id: 'new', revision: 1}], 1, async () => {})).rejects.toThrow();
        clock.mockReturnValue(2000);
        const event = await store.commitProposals('owner', 'dream', 'commit1', 'v1', [{id: 'new', revision: 1}], 1, async () => {});
        const active = await memory.active(async () => {});
        expect(active?.topics).toEqual([{id: 'legacy', content: 'Legacy rule'},
            {id: 'topic', content: 'Detailed body', kind: 'topic', priority: 7, updatedAt: 1000, title: 'Design'}]);
        expect(await store.commitProposals('owner', 'dream', 'commit1', 'v1', [{id: 'new', revision: 1}], 1, async () => {})).toEqual(event);
        await proposals.put({id: 'update', scope: 'owner', targetId: 'topic', revision: 1, status: 'ready', requiredScopes: ['source'],
            affectedMemoryIds: ['topic'], changes: [{id: 'topic', content: 'Revised body', kind: 'constraint', priority: 9}], evidenceIds: ['ev2']}, null);
        await store.commitProposals('owner', 'dream', 'commit2', event.version, [{id: 'update', revision: 1}], 1, async () => {});
        expect((await memory.active(async () => {}))?.topics[1]).toEqual({id: 'topic', content: 'Revised body', kind: 'constraint', priority: 9, updatedAt: 2000, title: 'Design'});
        await proposals.put({id: 'clear-title', scope: 'owner', targetId: 'topic', revision: 1, status: 'ready', requiredScopes: ['source'],
            affectedMemoryIds: ['topic'], changes: [{id: 'topic', content: 'Revised body', title: null}], evidenceIds: ['ev3']}, null);
        clock.mockReturnValue(3000);
        const current = await memory.active(async () => {});
        const third = await store.commitProposals('owner', 'dream', 'commit3', current!.version, [{id: 'clear-title', revision: 1}], 1, async () => {});
        expect((await memory.active(async () => {}))?.topics[1]).toEqual({id: 'topic', content: 'Revised body', kind: 'constraint', priority: 9, updatedAt: 3000});
        const downstream = new DreamDownstream(fs, async () => {});
        await downstream.consume('owner', 'dream', 'daily', third);
        expect((await downstream.read('owner', 'dream', 'daily', 'commit3'))?.changes).toMatchObject([
            {id: 'topic', action: 'update', kind: 'constraint', priority: 9, evidenceIds: ['ev3']},
        ]);
        await proposals.put({id: 'merge', scope: 'owner', targetId: 'topic', revision: 1, status: 'ready', requiredScopes: ['source'],
            affectedMemoryIds: ['legacy', 'topic'], changes: [{id: 'legacy', content: null}, {id: 'topic', content: 'Merged rule'}], evidenceIds: ['ev4']}, null);
        clock.mockReturnValue(4000);
        const merged = await store.commitProposals('owner', 'dream', 'commit4', third.version, [{id: 'merge', revision: 1}], 1, async () => {});
        expect((await memory.active(async () => {}))?.topics).toEqual([
            {id: 'topic', content: 'Merged rule', kind: 'constraint', priority: 9, updatedAt: 4000},
        ]);
        await proposals.put({id: 'retire', scope: 'owner', targetId: 'topic', revision: 1, status: 'ready', requiredScopes: ['source'],
            affectedMemoryIds: ['topic'], changes: [{id: 'topic', content: null}], evidenceIds: ['ev5']}, null);
        const retired = await store.commitProposals('owner', 'dream', 'commit5', merged.version, [{id: 'retire', revision: 1}], 1, async () => {});
        expect((await memory.active(async () => {}))?.topics).toEqual([]);
        await downstream.consume('owner', 'dream', 'daily', retired);
        expect((await downstream.read('owner', 'dream', 'daily', 'commit5'))?.changes).toMatchObject([
            {id: 'topic', action: 'retire', content: null, evidenceIds: ['ev5']},
        ]);
        fail.mockRestore(); clock.mockRestore();
    } finally {vi.restoreAllMocks(); await manager.dispose();}
});

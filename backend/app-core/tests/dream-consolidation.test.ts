import {expect, it} from 'vitest';
import {createVFS, MemoryBackend, type ISeqFileTransaction} from '@nestos/vfs-core';
import {MemoryCommitStore, ProposalStore} from '@nestos/dream/vfs';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {sha256HexSync} from '@nestos/common';

it('retains A and B authorization when a joint context references only B evidence', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture-b', 'a'.repeat(64), 'B');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'B'};
        await store.captureEvidence('owner', 'dream', {id: 'eB', projectId: 'B', sourceType: 'file', sourceId: 'B',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('B evidence'), locator: '/file', granularity: 'excerpt', snapshot: 'B evidence'}, null, 'next', 'capture-b');
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        const memory = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), path);
        await memory.stage({version: 'v1', parentVersion: null, requiredScopes: ['A'], topics: [{id: 'old', content: 'A context'}]});
        await memory.commit('prior', 'v1', null, async () => {});
        let revoked = false;
        const service = store.consolidation('owner', 'dream', {run: async input => {
            expect(input.memory?.topics[0].content).toBe('A context');
            expect(input.requiredScopes).toEqual(['A', 'B']);
            return [{id: 'proposal', targetId: 'new', status: 'ready', affectedMemoryIds: ['new'], changes: [{id: 'new', content: 'B result'}]}];
        }}, {evidence: async () => authority, evidenceScope: () => 'B', scopes: async scopes => {
            if (revoked && scopes.includes('A')) throw new Error('DREAM_AUTHORIZATION_DENIED');
        }});
        const [proposal] = await service.run({operationId: 'joint', captureOperationId: 'capture-b', scope: 'joint', scopes: ['A', 'B']});
        expect(proposal.evidenceIds).toEqual(['eB']); expect(proposal.requiredScopes).toEqual(['A', 'B']);
        revoked = true; await expect(service.read('proposal')).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
    } finally {await manager.dispose();}
});

it('retries the independent operation and makes its authorized proposals readable without repeating a completed model call', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture', 'a'.repeat(64), 'source');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'A'};
        await store.captureEvidence('owner', 'dream', {id: 'e1', projectId: 'A', sourceType: 'file', sourceId: 'source',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('proof'), locator: '/file', granularity: 'excerpt', snapshot: 'proof'}, null, 'next', 'capture');
        const source: [string, string, string] = ['A', 'file', 'source'];
        expect((await store.pendingCapturedOperations('owner', 'dream', 'joint', source, 0, 10, async () => authority)).items)
            .toMatchObject([{operationId: 'capture', sequence: 1, status: 'captured'}]);
        await expect(store.pendingCapturedOperations('owner', 'dream', 'joint', source, 0, 10, async () => {throw new Error('DENIED');}))
            .rejects.toThrow('DENIED');
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        const transaction = <T>(action: (tx: ISeqFileTransaction) => Promise<T>) => fs.meta.seq!.transaction!(action);
        const memory = new MemoryCommitStore(transaction, path), proposals = new ProposalStore(transaction, path);
        await memory.stage({version: 'v1', parentVersion: null, requiredScopes: ['C'], topics: [{id: 'old', content: 'old memory'}]});
        await memory.commit('prior', 'v1', null, async () => {});
        await proposals.put({id: 'pending', scope: 'joint', targetId: 'old', revision: 1, status: 'ready', requiredScopes: ['B'],
            affectedMemoryIds: ['old'], changes: [{id: 'old', content: 'pending memory'}], evidenceIds: ['older']}, null);
        await proposals.put({id: 'hidden', scope: 'joint', targetId: 'hidden', revision: 1, status: 'ready', requiredScopes: ['D'],
            affectedMemoryIds: ['hidden'], changes: [{id: 'hidden', content: 'private'}], evidenceIds: ['hidden-evidence']}, null);
        let calls = 0, denied = false;
        const authorization = {evidence: async () => authority, evidenceScope: () => 'A', scopes: async (scopes: readonly string[]) => {
            if (scopes.includes('D') || denied && scopes.includes('B')) throw new Error('DREAM_AUTHORIZATION_DENIED');
        }};
        const service = store.consolidation('owner', 'dream', {run: async input => {
            calls++;
            expect(input.requiredScopes).toEqual(['A', 'B', 'C']);
            expect(input.memory?.topics[0].content).toBe('old memory');
            expect(input.pending[0].id).toBe('pending');
            expect(input.pending).toHaveLength(1);
            if (calls === 1) throw new Error('temporary failure');
            return [{id: 'pending', targetId: 'old', status: 'ready', affectedMemoryIds: ['old'], changes: [{id: 'old', content: 'updated'}]}];
        }}, authorization);
        const request = {operationId: 'consolidate', captureOperationId: 'capture', scope: 'joint', scopes: ['A', 'B'], permittedScopes: ['A', 'B', 'C']};
        await expect(service.run(request)).rejects.toThrow('DREAM_CONSOLIDATION_MODEL_FAILED');
        await expect(service.run({...request, scopes: ['A']})).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        await expect(service.run({...request, focus: 'deployment'})).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        const [result] = await service.run(request);
        expect(result.revision).toBe(2);
        expect(result.evidenceIds).toEqual(['older', 'e1']);
        expect((await service.read('pending'))?.changes[0].content).toBe('updated');
        expect(await service.run(request)).toHaveLength(1);
        expect(calls).toBe(2);
        denied = true;
        await expect(service.read('pending')).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
    } finally {await manager.dispose();}
});

it('persists a no-op receipt and reuses it without another model invocation', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture', 'a'.repeat(64), 'source');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'A'};
        await store.captureEvidence('owner', 'dream', {id: 'e1', projectId: 'A', sourceType: 'file', sourceId: 'source',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('proof'), locator: '/file', granularity: 'excerpt', snapshot: 'proof'}, null, 'next', 'capture');
        let calls = 0;
        const service = store.consolidation('owner', 'dream', {run: async () => {calls++; return [];}},
            {evidence: async () => authority, evidenceScope: () => 'A', scopes: async () => {}});
        const request = {operationId: 'operation', captureOperationId: 'capture', scope: 'A', scopes: ['A'], pendingIds: []};
        expect(await service.run(request)).toEqual([]);
        expect(await service.run(request)).toEqual([]);
        expect(calls).toBe(1);
    } finally {await manager.dispose();}
});

it('does not persist model output if evidence authorization changes during the call', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture', 'a'.repeat(64), 'source');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'A'};
        await store.captureEvidence('owner', 'dream', {id: 'e1', projectId: 'A', sourceType: 'file', sourceId: 'source',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('proof'), locator: '/file', granularity: 'excerpt', snapshot: 'proof'}, null, 'next', 'capture');
        let revoked = false;
        const service = store.consolidation('owner', 'dream', {run: async () => {
            revoked = true;
            return [{id: 'proposal', targetId: 'memory', status: 'ready', affectedMemoryIds: ['memory'], changes: [{id: 'memory', content: 'value'}]}];
        }}, {evidence: async () => ({...authority, revision: revoked ? '2' : '1'}), evidenceScope: () => 'A', scopes: async () => {}});
        await expect(service.run({operationId: 'operation', captureOperationId: 'capture', scope: 'A', scopes: ['A'], pendingIds: []}))
            .rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
        expect(await service.read('proposal')).toBeNull();
    } finally {await manager.dispose();}
});

it('excludes A+B derived memory and proposals from an independent B context even when A is authorized', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture-b', 'a'.repeat(64), 'B');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'B'};
        await store.captureEvidence('owner', 'dream', {id: 'eb', projectId: 'B', sourceType: 'file', sourceId: 'B',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('B evidence'), locator: '/b', granularity: 'excerpt', snapshot: 'B evidence'}, null, 'next', 'capture-b');
        const path = '/var/lib/projects/owner/dream/dream/evidence.seq';
        const transaction = <T>(action: (tx: ISeqFileTransaction) => Promise<T>) => fs.meta.seq!.transaction!(action);
        const memory = new MemoryCommitStore(transaction, path), proposals = new ProposalStore(transaction, path);
        await memory.stage({version: 'joint-v1', parentVersion: null, requiredScopes: ['A', 'B'], topics: [{id: 'secret', content: 'A+B'}]});
        await memory.commit('joint-commit', 'joint-v1', null, async () => {});
        await proposals.put({id: 'joint-pending', scope: 'B', targetId: 'secret', revision: 1, status: 'ready', requiredScopes: ['A', 'B'],
            affectedMemoryIds: ['secret'], changes: [{id: 'secret', content: 'joint'}], evidenceIds: ['joint-evidence']}, null);
        const service = store.consolidation('owner', 'dream', {run: async input => {
            expect(input.memory).toBeNull(); expect(input.pending).toEqual([]); expect(input.requiredScopes).toEqual(['B']);
            return [{id: 'b-proposal', targetId: 'b-memory', status: 'ready', affectedMemoryIds: ['b-memory'], changes: [{id: 'b-memory', content: 'B only'}]}];
        }}, {evidence: async () => authority, evidenceScope: () => 'B', scopes: async () => {}});
        await expect(service.run({operationId: 'bad', captureOperationId: 'capture-b', scope: 'B', scopes: ['B'], pendingIds: ['joint-pending']}))
            .rejects.toThrow('DREAM_PROPOSAL_MISSING');
        const [proposal] = await service.run({operationId: 'b-operation', captureOperationId: 'capture-b', scope: 'B', scopes: ['B']});
        expect(proposal.requiredScopes).toEqual(['B']); expect(proposal.evidenceIds).toEqual(['eb']);
    } finally {await manager.dispose();}
});

it('rejects a captured snapshot changed during model execution', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        await store.prepare('owner', 'dream', 'capture', 'a'.repeat(64), 'source');
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'A'};
        await store.captureEvidence('owner', 'dream', {id: 'e1', projectId: 'A', sourceType: 'file', sourceId: 'source',
            connectionId: 'connection', authority, fingerprint: sha256HexSync('proof'), locator: '/file', granularity: 'excerpt', snapshot: 'proof'}, null, 'next', 'capture');
        const path = store.consolidationPath('owner', 'dream'), evidenceKey = 'evidence:["A","file","source",1]';
        const service = store.consolidation('owner', 'dream', {run: async () => {
            await fs.meta.seq!.transaction!(async tx => {
                const record = JSON.parse((await tx.getEntry(path, evidenceKey))!); record.evidence.snapshot = 'changed';
                await tx.setEntry(path, evidenceKey, JSON.stringify(record));
            });
            return [{id: 'proposal', targetId: 'memory', status: 'ready', affectedMemoryIds: ['memory'], changes: [{id: 'memory', content: 'value'}]}];
        }}, {evidence: async () => authority, evidenceScope: () => 'A', scopes: async () => {}});
        await expect(service.run({operationId: 'operation', captureOperationId: 'capture', scope: 'A', scopes: ['A']})).rejects.toThrow('DREAM_CAPTURE_INVALID');
        expect(await service.read('proposal')).toBeNull();
    } finally {await manager.dispose();}
});

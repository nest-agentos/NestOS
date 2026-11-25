import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamEvidenceStore} from '../src/dream/evidence-store';

it('preserves provenance and history across authorized, idempotent corrections and deactivation', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const result = {status: 'ok' as const, items: ['source'], evidence: {sourceId: 'source', projectId: 'project', connectionId: 'connection',
            authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 1}};
        await store.settle('owner', 'dream', 'scan', [result], [{id: 'fact', sourceId: 'source', kind: 'fact', content: 'Old', quote: 'source'}],
            {scanRunId: 'run', sessionId: 'session', taskId: 'task'});
        await expect(store.review('owner', 'dream', 'fact', 'denied', 0, {action: 'disable'}, async () => {throw new Error('private');}))
            .rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        expect((await store.finding('owner', 'dream', 'fact'))?.state).toBe('active');
        const corrected = await store.review('owner', 'dream', 'fact', 'correct', 0,
            {action: 'correct', content: 'Corrected', kind: 'inference'}, async () => {});
        expect(corrected).toMatchObject({revision: 1, state: 'active', origin: 'user-correction', kind: 'inference', quote: 'source'});
        expect(await store.review('owner', 'dream', 'fact', 'correct', 0,
            {action: 'correct', content: 'Corrected', kind: 'inference'}, async () => {})).toEqual(corrected);
        await expect(store.review('owner', 'dream', 'fact', 'stale', 0, {action: 'disable'}, async () => {})).rejects.toThrow('DREAM_REVIEW_CONFLICT');
        expect(await store.reviewHistory('owner', 'dream', 'fact', 1, async () => {})).toMatchObject({operationId: 'correct',
            previous: {content: 'Old', origin: 'source'}, result: {content: 'Corrected', origin: 'user-correction'}});
        await expect(store.reviewHistory('owner', 'dream', 'fact', 1, async () => {throw new Error('denied');})).rejects.toThrow();
        expect(await store.review('owner', 'dream', 'fact', 'disable', 1, {action: 'disable'}, async () => {})).toMatchObject({revision: 2, state: 'disabled'});
        expect(await store.review('owner', 'dream', 'fact', 'restore', 2, {action: 'restore'}, async () => {})).toMatchObject({revision: 3, state: 'active'});
        expect(await store.review('owner', 'dream', 'fact', 'dispute', 3, {action: 'dispute'}, async () => {})).toMatchObject({revision: 4, state: 'disputed'});
        expect(await store.review('owner', 'dream', 'fact', 'resolve', 4, {action: 'restore'}, async () => {})).toMatchObject({revision: 5, state: 'active'});
        expect(await store.reviewHistory('owner', 'dream', 'fact', 5, async () => {})).toMatchObject({previous: {state: 'disputed'}, result: {state: 'active'}});
    } finally {await manager.dispose();}
});

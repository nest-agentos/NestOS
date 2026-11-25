import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {PublishedConsolidationModel} from '../src/dream/consolidation-model';

it('reuses the persisted Session and admission after a lost submission reply', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/', name: 'dream.seq', type: 'seqfile'});
        let admission: unknown, submissions = 0;
        const requests: string[] = [];
        const calls = {
            inspectTaskCallSubmission: async (input: {request: {expectedSessionId: string}}) => {requests.push(input.request.expectedSessionId); return admission;},
            prepareTaskCall: async () => ({executionSessionId: 'child', plan: {task: {program: {kind: 'flow.aggregate'}, input: {initialScheduler: {spec: {nodes: [
                {plugin: 'builtin.agent', config: {}}, {plugin: 'builtin.return', config: {}},
            ]}}}}}}),
            submitPreparedTaskCall: async (input: {request: {expectedSessionId: string}}) => {
                submissions++; admission = {executionSessionId: 'child', submission: {task: {sessionId: input.request.expectedSessionId, taskId: 'task'}}};
                throw new Error('lost reply');
            },
        };
        const bound: string[] = []; let revoked = false;
        const model = new PublishedConsolidationModel({fs, path: '/dream.seq', target: {kind: 'flow', id: 'flow', version: 'v1', digest: 'digest'} as never,
            repository: {ensureSession: async () => {}} as never, calls: calls as never,
            kernel: {attachTask: async () => ({wait: async () => ({status: 'succeeded', output: {exit: {status: 'succeeded', output: {proposals: []}}}})})} as never,
            bindSession: async id => {bound.push(id);}, authorize: async () => {if (revoked) throw new Error('DREAM_AUTHORIZATION_DENIED');}});
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'A'};
        const input = {operationId: 'operation', evidence: {id: 'e1', projectId: 'A', sourceType: 'file', sourceId: 'source',
            connectionId: 'connection', authority, fingerprint: 'hash', locator: '/file', granularity: 'excerpt', snapshot: 'proof'},
            memory: null, pending: [], requiredScopes: ['A']};
        revoked = true;
        await expect(model.run(input)).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
        expect(submissions).toBe(0);
        revoked = false;
        expect(await model.run(input)).toEqual([]);
        expect(await model.run(input)).toEqual([]);
        expect(submissions).toBe(1);
        expect(bound).toContain('child');
        expect(new Set(requests).size).toBe(1);
        await expect(model.run({...input, requiredScopes: ['A', 'B']})).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        revoked = true;
        await expect(model.run(input)).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
        expect(submissions).toBe(1);
    } finally {await manager.dispose();}
});

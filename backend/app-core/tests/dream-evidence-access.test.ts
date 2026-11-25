import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {readAuthorizedDreamRun, retrieveDreamFacts} from '../src/dream/evidence-access';
import {DreamConfigStore} from '../src/dream/config-store';

it('retains authorized evidence while hiding evidence for a revoked or deselected project', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const items = ['allowed', 'revoked', 'removed'].map(id => ({status: 'ok' as const, items: [], evidence: {
            sourceId: id, projectId: id, connectionId: 'connection', authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 0}}));
        await store.settle('owner', 'dream', 'run', items, ['allowed', 'revoked', 'removed'].map(id => ({id: `finding-${id}`,
            sourceId: id, kind: 'fact', content: `result ${id}`})), {scanRunId: 'scan', sessionId: 'session', taskId: 'task'});
        const selected = ['allowed', 'revoked'].map(id => ({id, projectId: id, connectionId: 'connection', cursor: null}));
        const view = await readAuthorizedDreamRun(store, 'owner', 'dream', 'run', selected, {authorize: async source => {
            if (source.id === 'revoked') throw new Error('private failure details');
            return authority;
        }});
        expect(view?.sources).toEqual([
            {status: 'available', evidence: items[0].evidence},
            {status: 'unavailable', sourceId: 'revoked', code: 'AUTHORIZATION_FAILED'},
            {status: 'unavailable', sourceId: 'removed', code: 'SOURCE_NOT_SELECTED'},
        ]);
        expect(JSON.stringify(view)).not.toContain('private failure details');
        expect(view?.findings).toEqual([{id: 'finding-allowed', sourceId: 'allowed', kind: 'fact', content: 'result allowed', revision: 0, state: 'active', origin: 'source'}]);
        expect(JSON.stringify(view)).not.toContain('result revoked');
        expect(JSON.stringify(view)).not.toContain('result removed');
    } finally {await manager.dispose();}
});

it('retrieves only active facts within the configured session scope and current grants', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs), configs = new DreamConfigStore(fs);
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const source = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: [source]},
            {owner: async () => {}, source: async () => {}});
        await store.settle('owner', 'dream', 'run', [{status: 'ok', items: [], evidence: {sourceId: 'source', projectId: 'project',
            connectionId: 'connection', authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 0}}],
        [{id: 'fact', sourceId: 'source', kind: 'fact', content: 'Keep'}, {id: 'idea', sourceId: 'source', kind: 'suggestion', content: 'Do'}],
        {scanRunId: 'scan', sessionId: 'session', taskId: 'task'});
        const scope = {projectIds: ['project'], sourceIds: ['source']}, port = {authorize: async () => authority}, owner = async () => {};
        expect((await retrieveDreamFacts(store, configs, 'owner', 'dream', 'run', scope, port, owner)).map(f => f.id)).toEqual(['fact']);
        expect(await retrieveDreamFacts(store, configs, 'owner', 'dream', 'run', {...scope, sourceIds: []}, port, owner)).toEqual([]);
        await store.review('owner', 'dream', 'fact', 'disable', 0, {action: 'disable'}, async () => {});
        expect(await retrieveDreamFacts(store, configs, 'owner', 'dream', 'run', scope, port, owner)).toEqual([]);
        await expect(retrieveDreamFacts(store, configs, 'owner', 'dream', 'run', scope, port, async () => {throw new Error('denied');}))
            .rejects.toThrow('DREAM_OWNER_AUTHORIZATION_FAILED');
    } finally {await manager.dispose();}
});

it('does not reveal findings when a source loses its grant while the view is being prepared', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), store = new DreamEvidenceStore(fs);
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        await store.settle('owner', 'dream', 'run', [{status: 'ok', items: [], evidence: {sourceId: 'source', projectId: 'project',
            connectionId: 'connection', authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 1}}],
        [{id: 'finding', sourceId: 'source', kind: 'fact', content: 'private result'}], {scanRunId: 'scan', sessionId: 'session', taskId: 'task'});
        let checks = 0;
        const view = await readAuthorizedDreamRun(store, 'owner', 'dream', 'run',
            [{id: 'source', projectId: 'project', connectionId: 'connection', cursor: null}], {authorize: async () => {
                if (++checks === 2) throw new Error('revoked');
                return authority;
            }});
        expect(view?.findings).toEqual([]);
        expect(view?.sources).toEqual([{status: 'unavailable', sourceId: 'source', code: 'AUTHORIZATION_FAILED'}]);
        expect(JSON.stringify(view)).not.toContain('private result');
    } finally {await manager.dispose();}
});

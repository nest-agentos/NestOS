import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {scanSources} from '@nestos/dream';
import {NestosTwinSourceReader} from '../src/digital-twin/source-reader';
import {dreamProjectFileReader} from '../src/dream/project-file-source';
import {dreamRemoteSourcePort} from '../src/dream/remote-source';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {readAuthorizedDreamRun} from '../src/dream/evidence-access';

it('scans a real project file using the existing Twin reader and skips unchanged content', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/');
        await fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'Project notes'});
        const projects = {list: async () => [{project: {id: 'project', directory: '/', source: 'local'}, path: '/project'}],
            openFiles: async () => ({fs, dispose: async () => {}}), remoteMounts: {list: () => []}};
        const reader = new NestosTwinSourceReader(fs, {} as never, projects as never);
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const, path: '/notes/source.md'};
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const remote = {authorizeDreamSource: async () => authority};
        const port = dreamRemoteSourcePort(remote as never, [file], dreamProjectFileReader(reader, [file]));
        const source = {id: file.id, projectId: file.projectId, connectionId: file.connectionId, cursor: null};
        const [first] = await scanSources([source], 1, port);
        expect(first.status).toBe('ok');
        if (first.status !== 'ok') throw new Error('expected successful scan');
        expect(first.items).toEqual(['Project notes']);
        expect(first.evidence.scanned).toBe(1);
        const store = new DreamEvidenceStore(fs);
        const findings = [{id: 'finding', sourceId: file.id, kind: 'fact' as const, content: 'Derived result'}];
        await store.settle('owner', 'dream', 'operation', [first], findings, {scanRunId: 'scan', sessionId: 'session', taskId: 'task'});
        const view = await readAuthorizedDreamRun(store, 'owner', 'dream', 'operation', [source], port);
        expect(view?.findings).toMatchObject(findings);
        const [second] = await scanSources([{...source, cursor: first.evidence.endCursor}], 1, port);
        expect(second.status).toBe('ok');
        if (second.status !== 'ok') throw new Error('expected successful scan');
        expect(second.items).toEqual([]);
        expect(second.evidence.scanned).toBe(1);
        let checks = 0;
        const revoked = dreamRemoteSourcePort({authorizeDreamSource: async () => {
            if (++checks === 2) throw new Error('revoked');
            return authority;
        }} as never, [file], dreamProjectFileReader(reader, [file]));
        const [denied] = await scanSources([source], 1, revoked);
        expect(denied).toEqual({status: 'failed', sourceId: 'source', code: 'AUTHORIZATION_FAILED'});
        expect(JSON.stringify(denied)).not.toContain('Project notes');
        const revokedView = await readAuthorizedDreamRun(store, 'owner', 'dream', 'operation', [source],
            {authorize: async () => {throw new Error('revoked');}});
        expect(revokedView?.findings).toEqual([]);
    } finally {await manager.dispose();}
});

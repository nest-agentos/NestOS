import {expect, it, vi} from 'vitest';
import {createCellsDriver} from '@nestos/cells-driver';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {RemoteMountStore} from '../src/projects/remote-mount-store';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';

const authorization = {principalId: 'owner', anonymous: false, revision: 'a'.repeat(64)};
const connection = {id: 'node', name: 'Node', endpoint: 'https://files.test', credentialRef: 'secret', projects: true, authorization};
const projectAtStart = {id: 'native', name: 'Native', alias: 'docs', path: 'a', access: 'ro', revision: 1,
    mounts: [], rootIdentity: '1:2:3', mountIdentities: [], authorization,
    capabilities: {fileRead: true, fileWrite: false, run: false, sessionRead: false, sessionControl: false}};

async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/'), store = new RemoteMountStore(fs);
    const grant = {...connection, connectionId: 'node', serverProjectId: 'native', serverProjectRevision: 1,
        at: '/', root: '/a', alias: 'docs', access: 'ro' as const, mountId: 'original'};
    await store.load();
    await store.save({version: 1, revision: 1, connections: [connection], projects: {project: [grant]}});
    const project = structuredClone(projectAtStart);
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
        reply(new URL(String(input)).pathname, init, project));
    const before = vi.fn(async () => {}), after = vi.fn(async () => {});
    const remote = new ProjectRemoteMountService(fs, createCellsDriver(() => 'token', fetch), before, after);
    await remote.init();
    const view = await remote.compose('project', async () => { throw new Error('Unexpected local fallback'); });
    return {remote, view, store, project, fetch, before, after, async close() {
        await view.dispose(); await remote.dispose(); await manager.dispose();
    }};
}

function reply(path: string, init: RequestInit | undefined, project: typeof projectAtStart): Response {
    if (path === '/v1/capabilities') return Response.json({node: {api: {version: 1}}});
    if (path === '/v1/api/projects/read') return Response.json({ok: true, value: {project}});
    if (path === '/v1/api/projects/roots') return Response.json({ok: true, value: {roots: [{alias: 'docs', access: 'ro'}], execution: false, backend: 'fixture'}});
    if (path === '/v1/exports') return Response.json({version: 1, exports: [{alias: 'docs', access: 'ro'}]});
    if (new Headers(init?.headers).get('x-fsagent-project-revision') !== String(project.revision))
        return Response.json({code: 'PROJECT_REVISION_CHANGED'}, {status: 409});
    if (path.endsWith('/entries')) return Response.json({entries: [{name: 'note.md', stat: {kind: 'file'}}], nextCursor: null});
    if (path.endsWith('/stat')) {
        const {paths} = JSON.parse(String(init?.body)) as {paths: string[]};
        return Response.json({results: paths.map(path => ({stat: {kind: path.endsWith('.md') ? 'file' : 'directory'}}))});
    }
    if (path.endsWith('/content')) return new Response('remote text');
    return Response.json({code: 'UNEXPECTED_ROUTE'}, {status: 404});
}

it('recovers concurrent reads on the same open project file view and retains the saved binding', async () => {
    const f = await fixture();
    try {
        await f.remote.inspectProjectAccess('project');
        f.fetch.mockClear();
        f.project.revision++;
        const [text, entries] = await Promise.all([
            f.view.fs.driver.readContent('/note.md', {encoding: 'utf-8'}),
            f.view.fs.driver.getChildren('/'),
        ]);
        expect(text).toBe('remote text');
        expect(entries.map(entry => entry.name)).toContain('note.md');
        const calls = f.fetch.mock.calls.map(([url, init]) => [new URL(String(url)).pathname,
            new Headers(init?.headers).get('x-fsagent-project-revision')]);
        expect(calls.filter(([path]) => path === '/v1/api/projects/read')).toHaveLength(1);
        expect(calls.some(([path, revision]) => path.endsWith('/stat') && revision === '1')).toBe(true);
        expect(calls.filter(([path]) => path.endsWith('/content'))).toEqual([['/v1/fs/docs/content', '2']]);
        expect((await f.store.load())?.projects.project[0].serverProjectRevision).toBe(1);
        expect(f.before).not.toHaveBeenCalled(); expect(f.after).not.toHaveBeenCalled();
        expect((await f.remote.eventLog.query({projectId: 'project'})).events).toContainEqual(expect.objectContaining({
            operation: 'project.files.binding.recover', stage: 'verify', result: 'success', durationMs: expect.any(Number),
        }));
    } finally { await f.close(); }
});

it.each([
    ['directory', 'PROJECT_FILE_BINDING_DIRECTORY_CHANGED'],
    ['authorization', 'PROJECT_FILE_BINDING_AUTHORIZATION_CHANGED'],
    ['missing baseline', 'PROJECT_FILE_BINDING_DIRECTORY_UNVERIFIED'],
] as const)('keeps manual recovery when %s prevents proof', async (changed, code) => {
    const f = await fixture();
    try {
        if (changed !== 'missing baseline') await f.remote.inspectProjectAccess('project');
        f.project.revision++;
        if (changed === 'directory') f.project.rootIdentity = '1:2:4';
        if (changed === 'authorization') f.project.authorization.revision = 'b'.repeat(64);
        f.fetch.mockClear();
        await expect(f.view.fs.driver.getChildren('/')).rejects.toMatchObject({code: 'ECONFLICT'});
        expect(f.fetch.mock.calls.filter(([url, init]) => new URL(String(url)).pathname.startsWith('/v1/fs/')
            && new Headers(init?.headers).get('x-fsagent-project-revision') === '2')).toHaveLength(0);
        expect(await f.remote.projectStatus('project')).toMatchObject({problem: 'binding-outdated'});
        expect((await f.remote.eventLog.query({projectId: 'project'})).events).toContainEqual(expect.objectContaining({
            operation: 'project.files.binding.recover', stage: 'verify', result: 'failure', causeCodes: [code],
        }));
    } finally { await f.close(); }
});

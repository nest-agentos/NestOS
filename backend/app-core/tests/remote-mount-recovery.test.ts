import {afterEach, expect, it, vi} from 'vitest';
import {createFileSystemSource, FSError, MemoryBackend} from '@nestos/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
    let timedOut = false, disconnected = false, probes = 0;
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', remoteSourceProvider: {
        resolveCredential: () => 'fixture-secret', setCredential() {}, async dispose() {}, async open() {
            const backend = new MemoryBackend(); await backend.init(); await backend.write('/note.md', new TextEncoder().encode('retained content'));
            const owner = await createFileSystemSource({backend, viewId: 'recoverable-remote', access: 'rw'});
            const stat = owner.fs.driver.getNode.bind(owner.fs.driver), list = owner.fs.driver.getChildren.bind(owner.fs.driver);
            owner.fs.driver.getNode = async (path, options) => {
                if (path === '/') {probes++; if (disconnected) throw new FSError('ETIMEDOUT', 'Root probe timed out');}
                return stat(path, options);
            };
            owner.fs.driver.getChildren = (async (...args: Parameters<typeof list>) => {
                if (timedOut) throw new FSError('ETIMEDOUT', 'Directory read timed out');
                return list(...args);
            }) as typeof owner.fs.driver.getChildren;
            return owner;
        },
    }});
    const project = (await runtime.projects.current())!, remote = runtime.projects.remoteMounts!;
    const base = await runtime.projects.openFiles(project.path);
    try {await remote.add(project.project.id, {endpoint: 'https://files.test', alias: 'docs', root: '/', at: '/reference', access: 'rw'}, 'secret', base.fs);}
    finally {await base.dispose();}
    const workspace = await runtime.projects.openWorkspace(project.path);
    return {runtime, project, remote, workspace, timeout: () => {timedOut = true;}, disconnect: () => {disconnected = true;}, reconnect: () => {disconnected = false; timedOut = false;}, probes: () => probes};
}

it('recovers existing and newly opened workspaces after a transient directory timeout with one shared probe', async () => {
    const f = await fixture();
    try {
        f.timeout(); await expect(f.workspace.fs.driver.getChildren('/workspace/reference')).rejects.toMatchObject({code: 'ETIMEDOUT'});
        expect(f.remote.projectOffline(f.project.project.id)).toBe(true);
        const before = f.probes(), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3001); f.reconnect();
        const [text, second] = await Promise.all([
            f.workspace.fs.driver.readContent('/workspace/reference/note.md', {encoding: 'utf-8'}),
            f.runtime.projects.openWorkspace(f.project.path),
        ]);
        try {
            expect(text).toBe('retained content');
            expect(await second.fs.driver.readContent('/workspace/reference/note.md', {encoding: 'utf-8'})).toBe(text);
            expect(f.remote.projectOffline(f.project.project.id)).toBe(false); expect(f.probes() - before).toBe(1);
        } finally {await second.dispose();}
    } finally {await f.workspace.dispose(); await f.runtime.dispose();}
});

it('retains timeout classification and bounds repeated checks while the remote remains unavailable', async () => {
    const f = await fixture();
    try {
        f.timeout(); await expect(f.workspace.fs.driver.getChildren('/workspace/reference')).rejects.toMatchObject({code: 'ETIMEDOUT'});
        f.disconnect(); const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 3001); const before = f.probes();
        for (let attempt = 0; attempt < 2; attempt++) await expect(f.workspace.fs.driver.readContent('/workspace/reference/note.md', {encoding: 'utf-8'})).rejects.toMatchObject({code: 'ETIMEDOUT'});
        expect(f.probes() - before).toBe(1); expect(f.remote.projectOffline(f.project.project.id)).toBe(true);
    } finally {await f.workspace.dispose(); await f.runtime.dispose();}
});

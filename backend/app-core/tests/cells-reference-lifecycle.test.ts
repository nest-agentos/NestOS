import { expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDBBackend } from '@nestos/vfsdriver-indexeddb';
import { FSError, MemoryBackend, createFileSystemSource } from '@nestos/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { RemoteMountStore } from '../src/projects/remote-mount-store';
import { createSessionBrowser, folderBrowserPath } from '../src/session/session-browser';

async function fixture(backend = new MemoryBackend() as MemoryBackend | IndexedDBBackend) {
    const provider = {setCredential:vi.fn(),open:vi.fn(),dispose:vi.fn()};
    const runtime = await createApplicationRuntime({backend,ownerKind:'web',remoteSourceProvider:provider});
    const project = (await runtime.projects.list())[0];
    const store = new RemoteMountStore(await runtime.vfs.openFileSystem('/'));
    await store.load();
    const mount = {mountId:'mount',at:'/reference',root:'/',alias:'docs',access:'ro' as const,connectionId:'office',
        endpoint:'https://office.test',credentialRef:'cells-office',serverId:'office-node'};
    const connections=[{id:'office',name:'Office',endpoint:'https://office.test',credentialRef:'cells-office',serverId:'office-node'}];
    await store.save({version:1,revision:1,connections,projects:{[project.project.id]:[mount]}});
    await runtime.projects.remoteMounts!.init();
    return {runtime,provider,project,store,mount,connections};
}

it('keeps a workbench project visible when revoking its bindings fails and cleans them on retry',async () => {
    const {runtime,provider} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    const browser = await createSessionBrowser({repository:runtime.sessionRepository,files:runtime.sessionFiles,
        kernel:runtime.kernel.kernel,projects:runtime.projects});
    try {
        const project = await runtime.projects.createRemote('Workbench remote',null,'office','/docs','ro');
        const id = await runtime.sessionRepository.createSession('Keep until cleanup',await runtime.projects.sessionFolder(project));
        const forget = vi.spyOn(runtime.projects.remoteMounts!,'forgetProject').mockRejectedValueOnce(new FSError('EIO','Grant storage unavailable'));
        await expect(browser.fs.driver.delete([folderBrowserPath(project.path)],{recursive:true})).rejects.toMatchObject({code:'EIO'});
        expect(forget).toHaveBeenCalledWith(project.project.id);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(true);
        expect((await runtime.sessionRepository.listFolders()).some(item => item.path === project.path)).toBe(true);
        expect(await runtime.sessionRepository.getManifest(id)).toMatchObject({title:'Keep until cleanup'});
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toHaveLength(1);
        await browser.fs.driver.delete([folderBrowserPath(project.path)],{recursive:true});
        forget.mockRestore();
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
        expect(runtime.projects.remoteMounts!.list(project.project.id)).toEqual([]);
        expect(runtime.projects.remoteMounts!.mountedProjectIds()).not.toContain(project.project.id);
    } finally {await browser.dispose(); await runtime.dispose();}
});

it('repairs orphan remote roots on restart while retaining offline project identities',async () => {
    const backend = new IndexedDBBackend({dbName:`remote-delete-recovery-${crypto.randomUUID()}`});
    const {runtime,provider:connected,store,project,mount,connections} = await fixture(backend);
    const server = new MemoryBackend(); await server.init();
    connected.open.mockImplementation(async () => createFileSystemSource({backend:server,viewId:'server-fixture',access:'ro'}));
    const live = await runtime.projects.createRemote('Offline remote',null,'office','/docs','ro');
    const liveMounts = runtime.projects.remoteMounts!.list(live.project.id);
    // A missing navigation entry alone is not proof that a project was deleted.
    await runtime.sessionRepository.deleteFolder(live.path,true);
    await store.load();
    const id = 'deleted-before-upgrade';
    await store.save({version:1,revision:2,connections,projects:{[id]:[{...mount,mountId:'orphan',at:'/'}],
        [project.project.id]:[mount],[live.project.id]:liveMounts}});
    await runtime.dispose();
    const provider = {setCredential:vi.fn(),open:vi.fn().mockRejectedValue(new Error('Server offline')),dispose:vi.fn()};
    const reopened = await createApplicationRuntime({backend,ownerKind:'web',remoteSourceProvider:provider});
    try {
        expect(reopened.projects.remoteMounts!.list(id)).toEqual([]);
        expect(reopened.projects.remoteMounts!.list(project.project.id)).toHaveLength(1);
        expect(reopened.projects.remoteMounts!.list(live.project.id)).toHaveLength(1);
        expect((await reopened.projects.list()).some(project => project.project.id === live.project.id)).toBe(true);
        expect(provider.open).not.toHaveBeenCalled();
        const persisted = new RemoteMountStore(await reopened.vfs.openFileSystem('/'));
        expect((await persisted.load())!.projects[id]).toBeUndefined();
    } finally {await reopened.dispose();}
});

it('retains bindings when project identity storage cannot be read',async () => {
    const {runtime,store,mount,connections} = await fixture();
    try {
        await store.save({version:1,revision:2,connections,projects:{orphan:[{...mount,at:'/'}]}});
        const remote = runtime.projects.remoteMounts!;
        await remote.init();
        const lookup = vi.spyOn(runtime.projects,'storedProjectIds').mockRejectedValueOnce(new FSError('EIO','Identity storage unavailable'));
        await expect(remote.reconcileReferences()).rejects.toMatchObject({code:'EIO'});
        expect(remote.list('orphan')).toHaveLength(1);
        expect((await store.load())!.projects.orphan).toHaveLength(1);
        lookup.mockRestore();
    } finally {await runtime.dispose();}
});

it('repairs deleted remote identities without probing the server or removing attached local mounts',async () => {
    const {runtime,provider,store,project:local,connections} = await fixture();
    const backend = new MemoryBackend(); await backend.init();
    provider.open.mockImplementation(async () => createFileSystemSource({backend,viewId:'server-fixture',access:'ro'}));
    try {
        const project = await runtime.projects.createRemote('Deleted remote',null,'office','/docs','ro');
        const remote = runtime.projects.remoteMounts!, bindings = remote.list(project.project.id);
        // Reproduce an old interrupted deletion: both local identities and navigation are gone.
        await runtime.sessionRepository.deleteFolder(project.path,true);
        await runtime.projects.removeProjectSource(project);
        expect((await runtime.projects.list()).some(item => item.project.id === project.project.id)).toBe(false);
        expect(remote.list(project.project.id)).toHaveLength(1);
        provider.open.mockClear();
        provider.open.mockRejectedValue(new Error('Server offline'));
        await remote.reconcileReferences();
        expect(remote.list(local.project.id)).toMatchObject([{at:'/reference'}]);
        expect(remote.list(project.project.id)).toEqual([]);
        expect(provider.open).not.toHaveBeenCalled();
        expect((await store.load())!.projects[project.project.id]).toBeUndefined();
        // Startup reconciliation preserves independent node configuration.
        await store.save({version:1,revision:99,connections,projects:{[project.project.id]:bindings}});
        await remote.init();
        await remote.reconcileReferences();
        expect(remote.list(project.project.id)).toEqual([]);
        expect(remote.connections()).toHaveLength(1);
    } finally {await runtime.dispose();}
});

it('refuses to remove a Cells node while a project still references it',async()=>{
    const {runtime,project}=await fixture();const remote=runtime.projects.remoteMounts!;
    try {
        await expect(remote.removeConnection('office')).rejects.toMatchObject({code:'EBUSY'});
        expect(remote.list(project.project.id)).toHaveLength(1);
        await remote.forgetProject(project.project.id);await remote.removeConnection('office');
        expect(remote.connections()).toEqual([]);
    }finally{await runtime.dispose();}
});

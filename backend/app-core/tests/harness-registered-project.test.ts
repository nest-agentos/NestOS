import { afterEach, expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, type IVFSManager } from '@nestos/vfs-core';
import type { ProjectClient, RemoteProject } from '@nestos/cells-driver';
import { ProjectRemoteMountService, type ProjectRemoteMount } from '../src/projects/remote-mounts';

let manager: IVFSManager;
afterEach(async () => { await manager?.dispose(); });
async function fixture() {
    ({ manager } = await createVFS({ rootBackend: new MemoryBackend() }));
    const authorization = { principalId: 'owner', anonymous: false, revision: 'a'.repeat(64) };
    const mount: ProjectRemoteMount = { endpoint: 'https://node.test', credentialRef: 'host-only', connectionId: 'node',
        mountId: 'root', alias: 'docs', root: '/repo', at: '/', access: 'rw', serverProjectId: 'registered',
        serverProjectRevision: 2, authorization };
    const project: RemoteProject = { id: 'registered', name: 'Project', alias: 'docs', path: 'repo', access: 'rw',
        revision: 2, authorization: structuredClone(authorization), mounts: [] };
    const harness = {close: vi.fn(async () => {}), profiles: vi.fn(async () => ({epoch: 'epoch', profiles: [
        {id: 'codex', projectRuntime: true, workspaces: [{id: project.id}]},
    ]}))};
    const client = { read: vi.fn(async () => project), register: vi.fn(), close: vi.fn(async () => {}),
        harness: vi.fn(() => harness), draft: vi.fn(async () => ({conversationId: 'conversation'})) };
    const conversation = vi.fn(async () => ({snapshot: () => ({messages: [], requests: []}), subscribe: () => () => {}, close: harness.close}));
    const projects = vi.fn(() => client as unknown as ProjectClient);
    const service = new ProjectRemoteMountService(await manager.openFileSystem('/'), { projects, setCredential() {},
        conversation: conversation as never, open: async () => { throw new Error('Not used'); }, dispose: async () => {} }, async () => {}, async () => {});
    vi.spyOn(service, 'list').mockImplementation(() => structuredClone([mount]));
    vi.spyOn(service, 'resolveConnection').mockResolvedValue({ id: 'node', name: 'Node', endpoint: mount.endpoint,
        credentialRef: mount.credentialRef, authorization });
    return { service, client, projects, mount, project, conversation };
}

it('never registers legacy or missing projects during strict execution acquisition', async () => {
    const f = await fixture(); delete f.mount.serverProjectId;
    await expect(f.service.projectHarness('project', { requireRegistered: true })).rejects.toMatchObject({ code: 'ECAPABILITY' });
    expect(f.projects).not.toHaveBeenCalled(); expect(f.client.register).not.toHaveBeenCalled();
});

it('reuses one verified project read across profile discovery, identity resolution and conversation state', async () => {
    const f = await fixture();
    vi.spyOn(f.service, 'connection').mockReturnValue({id: 'node'} as never);
    const view = await f.service.projectConversation('project', 'codex', 'session');
    try {
        expect(f.projects).toHaveBeenCalledOnce();
        expect(f.client.read).toHaveBeenCalledExactlyOnceWith('registered', undefined);
        expect(f.client.draft).toHaveBeenCalledExactlyOnceWith(f.project, {action: 'resolve', profileId: 'codex', sessionId: 'session'}, undefined);
        expect(view.conversationId).toBe('conversation');
    } finally {await view.close();}
    expect(f.client.close).toHaveBeenCalledOnce();
});

it('requires the registered project revision and authorization before exposing its harness', async () => {
    const f = await fixture();
    const harness = await f.service.projectHarness('project', { requireRegistered: true }); await harness.close();
    expect(f.client.read).toHaveBeenCalledWith('registered', { requireRegistered: true });
    f.project.revision = 3;
    await expect(f.service.projectHarness('project', { requireRegistered: true })).rejects.toMatchObject({ code: 'ECONFLICT' });
    f.project.revision = 2; f.project.authorization!.revision = 'b'.repeat(64);
    await expect(f.service.projectHarness('project', { requireRegistered: true })).rejects.toMatchObject({ code: 'ECONFLICT' });
    expect(f.client.harness).toHaveBeenCalledOnce(); expect(f.client.close).toHaveBeenCalledTimes(3);
    expect(f.client.register).not.toHaveBeenCalled();
});

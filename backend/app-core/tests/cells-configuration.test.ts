import {expect,it,vi} from 'vitest';
import {MemoryBackend,createVFS} from '@nestos/vfs-core';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
it('persists independent Cells nodes and deletion without depending on an MCP catalog',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
    const discover=vi.fn(async (connection:{endpoint:string})=>({version:1 as const,httpEndpoint:connection.endpoint,serverId:'node',fileProtocol:'fs-agent-http-v1' as const,harness:true,projects:true}));
    const provider={discover,setCredential:vi.fn(),clearCredential:vi.fn(),open:async():Promise<never>=>{throw new Error('No file access');},dispose:async()=>{}};
    const make=()=>new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});
    let service=make();await service.init();

    try {
        const first=await service.saveConnection({name:'First',endpoint:'https://first.test'},'first');
        await service.saveConnection({name:'Second',endpoint:'https://second.test'},'second');
        expect(service.connections()).toHaveLength(2);expect(discover).toHaveBeenCalledTimes(2);
        await service.removeConnection(first);await service.dispose();
        service=make();await service.init();
        expect(service.connections().map(value=>value.name)).toEqual(['Second']);
        expect(service.connections()[0].projects).toBe(true);
    }finally{await service.dispose();await manager.dispose();}
});

it('recovers a missing referenced connection only with the original verified server and authorization', async () => {
    const {RemoteMountStore} = await import('../src/projects/remote-mount-store');
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const authorization = {principalId: 'owner', anonymous: false, revision: 'a'.repeat(64)};
    const store = new RemoteMountStore(fs);
    await store.save({version: 1, revision: 1, connections: [], projects: {project: [{mountId: 'root', at: '/', alias: 'x1', root: '/',
        access: 'rw', connectionId: 'missing', credentialRef: 'old', endpoint: 'http://node.test', serverId: 'original', authorization}]}});
    const discover = vi.fn(async () => ({version: 1 as const, httpEndpoint: 'http://node.test', serverId: 'foreign', authorization,
        fileProtocol: 'fs-agent-http-v1' as const, harness: true, projects: true}));
    const restore = vi.fn(), provider = {discover, setCredential: vi.fn(() => restore), open: async (): Promise<never> => {throw Error('Offline');}, dispose: async () => {}};
    const remote = new ProjectRemoteMountService(fs, provider, async () => {}, async () => {}); await remote.init();
    try {
        await expect(remote.saveConnection({name: 'Recovered', endpoint: 'http://node.test'}, 'private', 'missing')).rejects.toMatchObject({code: 'EBUSY'});
        expect(remote.connections()).toHaveLength(0); expect(restore).toHaveBeenCalledOnce();
        discover.mockImplementation(async () => ({version: 1, httpEndpoint: 'http://node.test', serverId: 'original', authorization,
            fileProtocol: 'fs-agent-http-v1', harness: true, projects: true}));
        expect(await remote.saveConnection({name: 'Recovered', endpoint: 'http://node.test'}, 'private', 'missing')).toBe('missing');
        expect(remote.connections()[0]).toMatchObject({id: 'missing', serverId: 'original', authorization});
        expect(remote.list('project')[0].connectionId).toBe('missing');
    } finally {await remote.dispose(); await manager.dispose();}
});

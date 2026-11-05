import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {RemoteMountStore} from '../src/projects/remote-mount-store';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();vi.restoreAllMocks();});
async function fixture(access:'ro'|'rw') {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');closes.push(()=>manager.dispose());
    const store=new RemoteMountStore(fs),connection={id:'node',name:'Office',endpoint:'https://node.test',credentialRef:'credential'};
    const catalog={version:1 as const,revision:1,connections:[connection],projects:{project:[{...connection,connectionId:'node',serverProjectId:'native',serverProjectRevision:1,mountId:'root',at:'/',root:'/',alias:'docs',access}]}};
    await store.save(catalog);
    const client={read:vi.fn(async()=>({id:'native',revision:1})),channel:vi.fn(async()=>({messages:[]})),close:vi.fn(async()=>{})};
    const provider={projects:vi.fn(()=>client as never),setCredential:vi.fn(),dispose:async()=>{},open:vi.fn()};
    const service=new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});await service.init();closes.push(()=>service.dispose());
    vi.spyOn(console,'error').mockImplementation(()=>{});
    return {service,store,catalog,client,provider};
}
it('enforces local read-only attenuation before any channel mutation reaches the node',async()=>{
    const f=await fixture('ro');
    await expect(f.service.sessionChannel('project','open',{scopeId:'attempt',cwd:'work'})).rejects.toMatchObject({code:'EROFS'});
    expect(f.provider.projects).not.toHaveBeenCalled();
    expect(await f.service.sessionChannel('project','messages',{scopeId:'attempt'})).toEqual({messages:[]});
});
it('rejects authorization changed during an async lookup and closes the client',async()=>{
    const f=await fixture('rw');
    f.client.read.mockImplementationOnce(async()=>{
        await f.store.save({...f.catalog,revision:2,projects:{}});await f.service.init();return {id:'native',revision:1};
    });
    await expect(f.service.sessionChannel('project','respond',{scopeId:'attempt'})).rejects.toMatchObject({code:'ECONFLICT'});
    expect(f.client.channel).not.toHaveBeenCalled();expect(f.client.close).toHaveBeenCalledOnce();
});

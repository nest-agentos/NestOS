import {expect,it,vi} from 'vitest';
import {MemoryBackend,FSError} from '@nestos/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {RemoteMountStore} from '../src/projects/remote-mount-store';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
it('aggregates all project mounts in one read without opening files or exposing credentials',async()=>{
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web'});
    const root=await runtime.vfs.openFileSystem('/'),store=new RemoteMountStore(root);
    const source={setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn(),nodeStatus:vi.fn(async()=>{throw new FSError('ECAPABILITY','unsupported');})};
    const remote=new ProjectRemoteMountService(root,source,async()=>{},async()=>{});
    try{
        await store.load();await store.save({version:1,revision:1,connections:[{id:'node',name:'Node',endpoint:'https://node.test',credentialRef:'private-reference'}],
            projects:{demo:[{mountId:'grant',at:'/docs',root:'/src',alias:'prj',access:'rw',connectionId:'node',endpoint:'https://node.test',credentialRef:'private-reference'},
                {mountId:'grant-src',at:'/code',root:'/src/lib',alias:'prj',access:'ro',connectionId:'node',endpoint:'https://node.test',credentialRef:'private-reference'}],
            other:[{mountId:'other',at:'/',root:'/',alias:'elsewhere',access:'ro',connectionId:'other-node',endpoint:'https://other.test',credentialRef:'other-secret'}]}});
        await remote.init();remote.projectSummaries=vi.fn(async()=>[{id:'demo',name:'Demo'},{id:'other',name:'Other'}]);
        const readStatus=vi.spyOn(remote,'projectStatus');
        const value=await remote.nodeOverview('node');
        expect(value.mounts).toEqual([
            {projectId:'demo',projectName:'Demo',mountId:'grant',alias:'prj',root:'/src',at:'/docs',access:'rw',status:'unknown',projectStatus:'unknown',canRemount:false,unmount:'directory'},
            {projectId:'demo',projectName:'Demo',mountId:'grant-src',alias:'prj',root:'/src/lib',at:'/code',access:'ro',status:'unknown',projectStatus:'unknown',canRemount:false,unmount:'directory'}]);
        expect(readStatus).toHaveBeenCalledExactlyOnceWith('demo');
        expect(value.statistics).toMatchObject({state:'unsupported'});expect(source.nodeStatus).toHaveBeenCalledOnce();
        expect(source.open).not.toHaveBeenCalled();expect(JSON.stringify(value)).not.toContain('private-reference');
        await expect(remote.nodeOverview('missing')).rejects.toMatchObject({code:'ENOENT'});
    }finally{await remote.dispose();await runtime.dispose();}
});

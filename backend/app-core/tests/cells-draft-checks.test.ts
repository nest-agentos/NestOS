import {expect,it,vi} from 'vitest';
import {MemoryBackend,FSError} from '@nestos/vfs-core';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
const input={name:'Node',endpoint:'https://node.test'};
async function setup(){
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web'});
    const secrets=new Map<string,string>();
    const source={setCredential:(ref:string,value:string)=>{secrets.set(ref,value);return()=>{secrets.delete(ref);};},clearCredential:(ref:string)=>{secrets.delete(ref);},
        dispose:vi.fn(),open:vi.fn(),discover:vi.fn(async()=>({version:1 as const,httpEndpoint:'https://node.test',serverId:'node',fileProtocol:'fs-agent-http-v1' as const,harness:true,projects:true}))};
    const remote=new ProjectRemoteMountService(await runtime.vfs.openFileSystem('/'),source,async()=>{},async()=>{});await remote.init();
    return {remote,source,secrets,close:async()=>{await remote.dispose();await runtime.dispose();}};
}
it('tests a private draft without saving and reuses its verified descriptor on explicit save',async()=>{
    const f=await setup();try{
        await f.remote.checkDraft(input,'private-fixture-token');expect(f.remote.connections()).toEqual([]);expect(f.secrets.size).toBe(0);
        const id=await f.remote.saveConnection({...input,name:'Renamed'},'private-fixture-token',undefined,{requireTested:true});
        expect(f.source.discover).toHaveBeenCalledOnce();expect(f.remote.connection(id)).toMatchObject({name:'Renamed',serverId:'node',projects:true});
        expect(JSON.stringify(f.remote.connections())).not.toContain('private-fixture-token');
        f.source.discover.mockClear();await f.remote.saveConnection({...input,name:'Renamed again'},'',id,{requireTested:true});
        expect(f.source.discover).not.toHaveBeenCalled();
    }finally{await f.close();}
});
it('rejects saving untested or changed connection parameters before mutating configuration',async()=>{
    const f=await setup();try{
        await expect(f.remote.saveConnection(input,'secret',undefined,{requireTested:true})).rejects.toThrow('CELLS_TEST_REQUIRED');
        await f.remote.checkDraft(input,'secret');
        await expect(f.remote.saveConnection({...input,endpoint:'https://changed.test'},'secret',undefined,{requireTested:true})).rejects.toThrow('CELLS_TEST_REQUIRED');
        await expect(f.remote.saveConnection(input,'changed-secret',undefined,{requireTested:true})).rejects.toThrow('CELLS_TEST_REQUIRED');
        expect(f.remote.connections()).toEqual([]);expect(f.secrets.size).toBe(0);
    }finally{await f.close();}
});
it('cleans temporary credentials after failed tests and does not turn failure into saved state',async()=>{
    const f=await setup();try{
        f.source.discover.mockRejectedValueOnce(new FSError('EACCES','denied'));
        await expect(f.remote.checkDraft(input,'secret')).rejects.toMatchObject({code:'EACCES'});
        expect(f.secrets.size).toBe(0);expect(f.remote.connections()).toEqual([]);
        await expect(f.remote.saveConnection(input,'secret',undefined,{requireTested:true})).rejects.toThrow('CELLS_TEST_REQUIRED');
    }finally{await f.close();}
});

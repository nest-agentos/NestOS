import {afterEach,expect,it,vi} from 'vitest';
import {MemoryBackend,FSError} from '@nestos/vfs-core';
import type {CellsDescriptor} from '@nestos/cells-driver';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {RemoteMountStore} from '../src/projects/remote-mount-store';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
const revision=(value:string)=>value.repeat(64);
const authorization=(value:string)=>({principalId:'owner',anonymous:false,revision:revision(value)});
const changed=()=>Object.assign(new FSError('EACCES','AUTHORIZATION_CHANGED'),{remoteCode:'AUTHORIZATION_CHANGED'});
afterEach(()=>vi.restoreAllMocks());
async function setup(){
    const runtime=await createApplicationRuntime({backend:new MemoryBackend(),ownerKind:'web'});
    const fs=await runtime.vfs.openFileSystem('/'),store=new RemoteMountStore(fs),beforeChange=vi.fn(async()=>{});
    let descriptor:CellsDescriptor={version:1,httpEndpoint:'https://node.test',serverId:'node',fileProtocol:'fs-agent-http-v1',harness:true,projects:true,authorization:authorization('b')};
    const source={setCredential:vi.fn(),dispose:vi.fn(),open:vi.fn(async()=>{throw changed();}),
        check:vi.fn(async()=>{throw changed();}),nodeStatus:vi.fn(async()=>{throw changed();}),
        discover:vi.fn(async()=>structuredClone(descriptor))};
    const remote=new ProjectRemoteMountService(fs,source,beforeChange,async()=>{});
    await store.load();await store.save({version:1,revision:1,connections:[{id:'node',name:'Node',endpoint:'https://node.test',credentialRef:'private-reference',serverId:'node',authorization:authorization('a')}],
        projects:{demo:[{mountId:'root',at:'/',alias:'prj',root:'/demo',access:'rw',connectionId:'node',endpoint:'https://node.test',credentialRef:'private-reference',authorization:authorization('a'),serverProjectId:'demo',serverProjectRevision:1}]}});
    await remote.init();remote.projectSummaries=async()=>[{id:'demo',name:'Demo',remote:true}];
    return {remote,source,beforeChange,setDescriptor:(value:Partial<CellsDescriptor>)=>{descriptor={...descriptor,...value};},close:async()=>{await remote.dispose();await runtime.dispose();}};
}
async function proposal(f:Awaited<ReturnType<typeof setup>>){
    const value=await f.remote.nodeOverview('node');
    if(value.authorizationRefresh?.state!=='available')throw new Error('Expected confirmation proposal');
    return value.authorizationRefresh;
}
it('discovers a changed grant without writing and commits only a fresh explicit confirmation, preserving project grants',async()=>{
    const f=await setup();try{
        const value=await proposal(f);
        expect(value).toMatchObject({serverId:'node',principalId:'owner',previousRevision:revision('a'),nextRevision:revision('b'),affectedProjectIds:['demo']});
        expect(f.remote.connection('node').authorization).toEqual(authorization('a'));
        expect(f.source.discover.mock.calls[0]![0].authorization).toBeUndefined();
        expect(JSON.stringify(value)).not.toContain('private-reference');
        await f.remote.nodeOverview('node');expect(f.source.discover).toHaveBeenCalledTimes(1);
        await f.remote.confirmAuthorizationRefresh('node',value.proposalId);
        expect(f.source.discover).toHaveBeenCalledTimes(2);expect(f.remote.connection('node').authorization).toEqual(authorization('b'));
        expect(f.remote.list('demo')[0]!.authorization).toEqual(authorization('a'));expect(f.beforeChange).toHaveBeenCalledWith('demo');
        await expect(f.remote.confirmAuthorizationRefresh('node',value.proposalId)).rejects.toThrow('CELLS_AUTHORIZATION_REFRESH_EXPIRED');
    }finally{await f.close();}
});
it.each([
    [{serverId:'other'},'server-changed'],
    [{authorization:{...authorization('b'),principalId:'other'}},'principal-changed'],
    [{authorization:undefined},'identity-unverified'],
    [{httpEndpoint:'https://other.test'},'server-changed']
] as const)('blocks identity changes without offering a confirmation token: %s',async(value,reason)=>{
    const f=await setup();try{
        f.setDescriptor(value);const result=await f.remote.nodeOverview('node');
        expect(result.authorizationRefresh).toEqual({state:'blocked',reason});expect(f.remote.connection('node').authorization).toEqual(authorization('a'));
        await expect(f.remote.confirmAuthorizationRefresh('node','invented')).rejects.toThrow('CELLS_AUTHORIZATION_REFRESH_EXPIRED');
    }finally{await f.close();}
});
it('rejects an expired proposal and a grant that changes again while confirming',async()=>{
    const f=await setup();try{
        const value=await proposal(f),now=Date.now();
        vi.spyOn(Date,'now').mockReturnValue(now+6*60_000);
        await expect(f.remote.confirmAuthorizationRefresh('node',value.proposalId)).rejects.toThrow('CELLS_AUTHORIZATION_REFRESH_EXPIRED');
        vi.restoreAllMocks();const next=await proposal(f);f.setDescriptor({authorization:authorization('c')});
        await expect(f.remote.confirmAuthorizationRefresh('node',next.proposalId)).rejects.toThrow('CELLS_AUTHORIZATION_REFRESH_CHANGED');
        expect(f.remote.connection('node').authorization).toEqual(authorization('a'));
    }finally{await f.close();}
});
it('does not discover for unrelated failures, preserves discovery failure reasons and honors mutation guards',async()=>{
    const f=await setup();try{
        f.source.nodeStatus.mockRejectedValueOnce(new FSError('ECAPABILITY','no metrics'));
        expect((await f.remote.nodeOverview('node')).authorizationRefresh).toBeUndefined();expect(f.source.discover).not.toHaveBeenCalled();
        const value=await proposal(f);f.beforeChange.mockRejectedValueOnce(new FSError('EBUSY','running sessions'));
        await expect(f.remote.confirmAuthorizationRefresh('node',value.proposalId)).rejects.toMatchObject({code:'EBUSY'});
        expect(f.remote.connection('node').authorization).toEqual(authorization('a'));
    }finally{await f.close();}
    const f2=await setup();try{
        f2.source.discover.mockRejectedValueOnce(new FSError('ETIMEDOUT','private message'));
        expect((await f2.remote.nodeOverview('node')).authorizationRefresh).toEqual({state:'unavailable',code:'ETIMEDOUT'});
    }finally{await f2.close();}
});
it('rechecks identity at confirmation time and discards cancelled discovery',async()=>{
    const f=await setup();try{
        const value=await proposal(f);f.setDescriptor({serverId:'different'});
        await expect(f.remote.confirmAuthorizationRefresh('node',value.proposalId)).rejects.toThrow('CELLS_AUTHORIZATION_IDENTITY_CHANGED');
        expect(f.remote.connection('node').authorization).toEqual(authorization('a'));
    }finally{await f.close();}
    const f2=await setup();try{
        const controller=new AbortController();let release!:(value:CellsDescriptor)=>void;
        f2.source.discover.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
        const pending=f2.remote.nodeOverview('node',{signal:controller.signal});
        await vi.waitFor(()=>expect(f2.source.discover).toHaveBeenCalledOnce());controller.abort();
        release({version:1,httpEndpoint:'https://node.test',serverId:'node',fileProtocol:'fs-agent-http-v1',harness:true,projects:true,authorization:authorization('b')});
        await expect(pending).rejects.toMatchObject({code:'ECANCELLED'});
        expect(f2.remote.connection('node').authorization).toEqual(authorization('a'));
    }finally{await f2.close();}
});

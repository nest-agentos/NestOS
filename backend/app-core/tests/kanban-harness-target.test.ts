import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {kanbanHarnessTarget} from '../src/presets/kanban-harness-target';
import {publishManagedAgent} from '../src/configuration/managed-agent';
vi.mock('../src/configuration/managed-agent',()=>({publishManagedAgent:vi.fn(async(_agents,_journal,definition)=>({kind:'agent',id:definition.id,version:'1',digest:'managed'}))}));
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.clearAllMocks();});
async function fixture(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
    const target={kind:'agent',id:'worker',version:'1',digest:'original'};
    const template={id:'shared',profileId:'default',projectId:'project',selection:{model:'old-model'}};
    const saved=new Map<string,unknown>(),save=vi.fn(async(connection:any)=>{saved.set(connection.id,{connection});});
    const close=vi.fn(async()=>{}),profile={id:'chosen',projectRuntime:true,workspaces:[{id:'workspace'}],capabilities:{create:true,sessionChannels:true,workingDirectory:true}};
    const getAgentRevision=vi.fn(async()=>({target,definition:{id:'worker',config:{},execution:{kind:'harness',connectionId:'shared'}}}));
    const prepare=kanbanHarnessTarget({fs,agents:{getAgentRevision},connections:{get:async(id:string)=>id==='shared'?{connection:template}:saved.get(id),save},remote:{list:()=>[{at:'/',serverProjectId:'workspace'}],projectHarness:async()=>({profiles:async()=>({profiles:[profile]}),close})}} as never);
    return {prepare,target,template,save,getAgentRevision,close};
}
it('binds a new direct execution to a private connection and preserves the original profile across retries',async()=>{
    const f=await fixture(),input={board:{id:'board',settings:{'harness-execution':'chosen'}},dispatch:{id:'attempt'},target:f.target};
    expect(await f.prepare(input as never)).toMatchObject({id:'kanban-attempt'});
    expect(f.save).toHaveBeenCalledWith(expect.objectContaining({profileId:'chosen',selection:undefined}),0);
    expect(f.template).toMatchObject({profileId:'default',selection:{model:'old-model'}});
    input.board.settings['harness-execution']='missing';expect(await f.prepare(input as never)).toMatchObject({id:'kanban-attempt'});expect(f.save).toHaveBeenCalledOnce();expect(f.close).toHaveBeenCalledTimes(2);
    expect(publishManagedAgent).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({execution:{kind:'harness',connectionId:'kanban-attempt'}}));
});
it('freezes the default choice and rejects an explicit profile for a non-native target',async()=>{
    const f=await fixture(),input={board:{id:'board',settings:{}},dispatch:{id:'default-attempt'},target:f.target};
    expect(await f.prepare(input as never)).toEqual(f.target);
    input.board.settings={'harness-execution':'chosen'};expect(await f.prepare(input as never)).toEqual(f.target);expect(f.getAgentRevision).not.toHaveBeenCalled();
    await expect(f.prepare({...input,dispatch:{id:'flow-attempt'},target:{...f.target,kind:'flow'}} as never)).rejects.toMatchObject({code:'NATIVE_AGENT_REQUIRED'});
});

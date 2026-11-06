import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {developmentPreparation} from '../src/presets/kanban-development';
import {readPrompt} from '../src/run/prompt-bundle';
vi.mock('../src/presets/kanban-development-policy',()=>({developmentPolicy:async()=>({version:1,profile:'development',commit:'changes',modules:[],prompts:{version:1,files:[]}})}));
vi.mock('../src/presets/kanban-development-workspace',()=>({developmentWorkspace:async(_remote,_provider,_project,run)=>run({})}));
vi.mock('../src/projects/worktree-preparation',()=>({prepareWorktree:async(_journal,id,directory)=>({id,directory,branch:'work/'+id,baseCommit:'base'})}));
vi.mock('../src/projects/worktree-modules',()=>({prepareWorktreeModules:async()=>[{path:'.',branch:'work/attempt',baseCommit:'base'}],availableWorktreeModules:async()=>[]}));
vi.mock('../src/configuration/managed-agent',()=>({publishManagedAgent:async()=>({kind:'agent',id:'managed',version:'1',digest:'a'.repeat(64)})}));
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(count:number){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs,kanbanJournalOptions);await journal.open();
    const target={kind:'agent',id:'worker',version:'1',digest:'a'.repeat(64)},close=vi.fn(async()=>{});
    const projectHarness=vi.fn(async()=>({profiles:async()=>({profiles:[{id:'native',capabilities:{workingDirectory:true,sessionChannels:true}}]}),close}));
    const sessionChannel=vi.fn(async(_project,_operation,request)=>{expect(Buffer.byteLength(JSON.stringify(request.snapshot))).toBeLessThan(2*1024*1024);return {accepted:true};});
    const openWorkspace=vi.fn(async()=>({fs,dispose:async()=>{}}));
    const options={fs,provider:{},agents:{getAgentRevision:async()=>({target,definition:{config:{},execution:{kind:'harness',connectionId:'template'}}})},
        connections:{get:async(id:string)=>id==='template'?{connection:{profileId:'native'}}:undefined,save:async()=>{}},
        projects:{get:async()=>({path:'/project'}),openWorkspace},remote:{projectHarness,sessionChannel,list:()=>[{at:'/',connectionId:'node'}]}};
    const item={id:'current',title:'Current requirement',responsibility:'Implement this decision',acceptance:'Preserve current criteria',externalRefs:[{system:'nestos-remote-project',id:'project'}]};
    const candidates=Array.from({length:count},(_,i)=>({id:'history-'+i,title:'历史事项 '+i,status:'completed',responsibility:'无关历史正文'.repeat(400),acceptance:'Historical criteria',planning:{kind:'task',dependencies:[]}}));
    const context={board:{id:'board'},task:{id:item.id,responsibility:item.responsibility,acceptance:item.acceptance},decision:{recordId:'decision',snapshot:{content:'Original current decision'}},snapshot:{item,items:candidates,workTypes:[],defaultWorkType:'task'}};
    return {fs,journal,target,item,context,options,projectHarness,sessionChannel,openWorkspace,close};
}
it.each([1,50,200])('keeps real preparation bounded with %i UTF-8 history candidates',async count=>{
    const f=await fixture(count),started=Date.now();
    const inputBytes=Buffer.byteLength(JSON.stringify(f.context));if(count>=50)expect(inputBytes).toBeGreaterThan(49152);
    await developmentPreparation(f.options as never)({target:f.target,context:f.context,item:f.item,stage:'decision',preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},dispatch:{id:'attempt',itemId:f.item.id}} as never);
    const manifest=await readPrompt(f.fs,'/workspace/_nestos/worktrees/attempt/_nestos/kanban/manifest.json');
    const commit=await f.journal.get<{input:unknown}>('development-commit-context:attempt');
    expect(Buffer.byteLength(manifest)).toBeLessThan(65536);expect(Buffer.byteLength(JSON.stringify(commit))).toBeLessThan(49152);
    expect(manifest).not.toContain('无关历史正文');expect(JSON.stringify(commit)).not.toContain('无关历史正文');
    expect(JSON.parse(manifest).context.input.task.acceptance).toBe(f.item.acceptance);
    expect(JSON.parse(manifest).context.input.decision.snapshot.content).toBe('Original current decision');
    const snapshot=f.sessionChannel.mock.calls[0][2].snapshot;
    expect(snapshot['planning-input'].items).toHaveLength(count);
    expect(snapshot['dependency:history-0'].responsibility).toBe(f.context.snapshot.items[0].responsibility);
    expect(Buffer.byteLength(JSON.stringify(snapshot['planning-input']))).toBeLessThan(65536);
    expect(f.projectHarness).toHaveBeenCalledOnce();expect(f.openWorkspace).toHaveBeenCalledOnce();expect(f.sessionChannel).toHaveBeenCalledOnce();expect(f.close).toHaveBeenCalledOnce();
    const durationMs=Date.now()-started;expect(durationMs).toBeLessThan(5000);
    console.info(JSON.stringify({operation:'kanban.context.acceptance',candidateCount:count,inputBytes,manifestBytes:Buffer.byteLength(manifest),commitBytes:Buffer.byteLength(JSON.stringify(commit)),channelCalls:f.sessionChannel.mock.calls.length,workspaceOpens:f.openWorkspace.mock.calls.length,durationMs}));
});

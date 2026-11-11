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
it('does not append history or duplicate prompt sections when the same preparation resumes',async()=>{
    const f=await fixture(50),prepare=developmentPreparation(f.options as never);
    const input={target:f.target,context:f.context,item:f.item,stage:'decision',preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},dispatch:{id:'attempt',itemId:f.item.id}};
    let originalManifest='',originalCommit='',originalSnapshot='';
    for(let attempt=0;attempt<10;attempt++){
        await prepare(input as never);
        const manifest=await readPrompt(f.fs,'/workspace/_nestos/worktrees/attempt/_nestos/kanban/manifest.json');
        const commit=JSON.stringify(await f.journal.get('development-commit-context:attempt'));
        const snapshot=JSON.stringify(f.sessionChannel.mock.calls.at(-1)![2].snapshot);
        if(attempt===0){originalManifest=manifest;originalCommit=commit;originalSnapshot=snapshot;}
        expect(manifest).toBe(originalManifest);expect(commit).toBe(originalCommit);expect(snapshot).toBe(originalSnapshot);
    }
    expect(f.sessionChannel).toHaveBeenCalledTimes(10);expect(f.openWorkspace).toHaveBeenCalledTimes(10);
});

it('prepares a shared coordination group on its primary project with all selected project contexts',async()=>{
 const f=await fixture(1),projectIds=['project','secondary'];
 f.options.remote.list=(id:string)=>[{at:'/',connectionId:'node',serverId:'cell',serverProjectId:'cell-'+id,serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}}] as any;
 f.sessionChannel.mockImplementation(async(_project,_operation,request)=>({accepted:true,projectContext:{projects:request.contextProjects.map((row:any)=>({...row,directory:'/projects/'+row.projectId}))}}));
 const item={...f.item,externalRefs:projectIds.map(id=>({system:'nestos-remote-project',id}))};
 const context={...f.context,primaryProjectId:'secondary',projectIds,secondaryProjectIds:['project']};
 await developmentPreparation(f.options as never)({target:f.target,context,item,stage:'decision',preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},dispatch:{id:'shared',itemId:item.id}} as never);
 expect(f.projectHarness).toHaveBeenCalledWith('secondary',expect.anything());
 expect(f.sessionChannel).toHaveBeenCalledWith('secondary','open',expect.objectContaining({contextProjects:[{projectId:'cell-project',revision:1},{projectId:'cell-secondary',revision:1}]}));
 await expect(developmentPreparation(f.options as never)({target:f.target,context,item,stage:'task',preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},dispatch:{id:'execution',itemId:item.id}} as never)).rejects.toMatchObject({code:'SINGLE_PROJECT_TASK_REQUIRED'});
});

it.each([['decision','coordination'],['task','execution']] as const)('binds %s work to the board %s profile and retains it across setting changes',async(stage,role)=>{
    const f=await fixture(1),save=vi.fn(async()=>{});f.options.connections.save=save;
    f.projectHarness.mockImplementation(async()=>({profiles:async()=>({profiles:[{id:'chosen',capabilities:{workingDirectory:true,sessionChannels:true}}]}),close:f.close}));
    const input={board:{id:'board',settings:{['harness-'+role]:'chosen'}},target:f.target,context:f.context,item:f.item,stage,preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'},dispatch:{id:'attempt',itemId:f.item.id}};
    const prepare=developmentPreparation(f.options as never);await prepare(input as never);input.board.settings['harness-'+role]='missing';await prepare(input as never);
    expect(save).toHaveBeenCalledTimes(2);for(const [connection]of save.mock.calls as unknown as Array<[{profileId:string}]>)expect(connection.profileId).toBe('chosen');
});

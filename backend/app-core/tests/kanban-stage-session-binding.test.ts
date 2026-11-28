import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import type {HarnessProfile} from '@nestos/cells-driver';
import type {KanbanStageHarnesses,KanbanStageHarnessModels,KanbanHarnessModelSelection} from '@nestos/kanban/contracts';
import {createRecordConversations,KanbanAutomationJournal} from '@nestos/kanban/integration';
import {decisionConversationTransport} from '../src/kanban/decision-conversation-transport';
import {resolveNativeWork,publishNativeWork} from '../src/presets/kanban-native-workspace';
import {decisionHarnessReferences} from '../src/presets/kanban-harness-settings';
import {fixture as harnessFixture,complete,request} from './harness-execution-fixture';

vi.mock('../src/configuration/managed-agent',()=>({publishManagedAgent:vi.fn(async(_agents,_journal,definition)=>({kind:'agent',id:definition.id,version:'1',digest:'managed'}))}));
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const workspace='workspace',project='project';
const resources=[{system:'nestos-remote-project',id:project}];
const actor={kind:'human',id:'operator'};
const stageChoices={decision:'discussion-explicit',coordination:'coordination-explicit',execution:'execution-explicit'};
const defaults={decision:'discussion-default',coordination:'coordination-default',execution:'execution-default'};
function profile(id:string):HarnessProfile {
    return {id,kind:id,projectRuntime:true,workspaces:[{id:workspace}],capabilities:{create:true,history:true,resume:true,interrupt:true,interactions:true,workingDirectory:true,sessionChannels:true,models:true}};
}
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});cleanup.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
    const settings=Object.fromEntries(Object.entries(defaults).map(([role,id])=>['harness-'+role,id]));
    const board={id:'b',settings,members:[{...actor,roles:['coordinator']}]};
    const profiles=[...Object.values(stageChoices),...Object.values(defaults),'replacement'].map(profile);
    const create=vi.fn(async(id:string)=>({session:{id:'native-'+id}})),enqueue=vi.fn(async(_selection?:KanbanHarnessModelSelection)=>{});
    const fault={enqueue:false};
    const remote={list:()=>[{at:'/',connectionId:'node',serverId:'cell',serverProjectId:workspace,serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}}],
        projectHarness:async()=>({profiles:async()=>({epoch:'epoch',profiles}),models:async(profileId:string)=>({models:[{id:'model-'+profileId,label:'Model',reasoningEfforts:[{id:'high',label:'High'}]}]}),close:async()=>{},create,subscribeChannel:()=>()=>{}}),
        projectConversation:async()=>({close:async()=>{},enqueue:async(_text:string,_attachments:unknown[],selection?:KanbanHarnessModelSelection)=>{if(fault.enqueue)throw Object.assign(Error('Lost enqueue'),{code:'EIO'});await enqueue(selection);}}),
        sessionChannel:async()=>({projectContext:{projects:[{projectId:workspace,revision:1,directory:'/workspace'}]}})};
    const projectService={get:async()=>({path:'/project',project:{id:project,source:{kind:'remote'}}}),openWorkspace:async()=>({fs,dispose:async()=>{}})};
    const log=vi.fn(),service={read:async()=>board,currentPrincipal:async()=>actor};
    const open=(persistent=journal)=>{const transport=decisionConversationTransport({fs,journal:persistent,service,projects:projectService,remote,log} as never,async()=>({state:'clarifying'}));
        const runtime=createRecordConversations({service,journal:persistent,port:transport,log} as never);cleanup.push(()=>runtime.quiesce());return runtime;};
    return {fs,journal,remote,settings,board,profiles,create,enqueue,open,log,fault};
}
async function bindWork(f:Awaited<ReturnType<typeof fixture>>,role:'coordination'|'execution',harnesses?:KanbanStageHarnesses,models?:KanbanStageHarnessModels) {
    const target={kind:'agent',id:'worker',version:'1',digest:'original'},saved=new Map<string,Record<string,unknown>>();
    const options={remote:f.remote,agents:{getAgentRevision:async()=>({target,definition:{id:'worker',config:{},execution:{kind:'harness',connectionId:'shared'}}})},
        connections:{get:async(id:string)=>id==='shared'?{connection:{id,projectId:project,profileId:defaults[role]}}:
            saved.has(id)?{connection:saved.get(id)}:undefined,
            save:async(connection:Record<string,unknown>)=>saved.set(connection.id as string,connection)}};
    const context={decision:{snapshot:{externalRefs:[...resources,...decisionHarnessReferences(harnesses,models)]}}};
    const input={board:f.board,dispatch:{id:role},stage:role==='coordination'?'decision':undefined,target,context,item:{id:role,title:'Work',externalRefs:resources}};
    const binding=await resolveNativeWork(options as never,f.journal,input as never);
    await publishNativeWork(options as never,f.journal,input as never,binding,'_nestos/worktrees/'+role,'Test');
    const selected=saved.get('work-'+role)!.profileId as string;
    const native=harnessFixture();native.profile.id=selected;native.session.cwd='/projects/workspace/_nestos/worktrees/'+role;complete(native);
    await native.make().execute({...request,connection:{...request.connection,...saved.get('work-'+role),profileId:selected}},native.context);
    expect(native.client.create).toHaveBeenCalledExactlyOnceWith(selected,workspace,expect.objectContaining({requestId:expect.any(String)}));
    if(models?.[role])expect(native.client.turn).toHaveBeenCalledWith(selected,expect.any(String),expect.any(String),expect.objectContaining({selection:models[role]}));
    f.settings['harness-'+role]='replacement';
    const reopened=new KanbanAutomationJournal(f.fs);await reopened.open();
    expect(await resolveNativeWork(options as never,reopened,input as never)).toMatchObject({profileId:selected,...(models?.[role]?{selection:models[role]}:{})});
    return selected;
}
it.each([
    ['three explicit choices',stageChoices,stageChoices],
    ['mixed choices',{coordination:stageChoices.coordination},{...defaults,coordination:stageChoices.coordination}],
    ['all defaults',{},defaults],
    ['historical absence',undefined,defaults],
] as const)('binds the created Sessions for %s',async(_label,harnesses,expected)=>{
    const f=await fixture(),runtime=f.open();
    const discussion=await runtime.startRecordConversation('b',{operationId:'discussion',resources,primaryResource:resources[0],harnesses});
    expect(discussion.resourceId).toBe('/folder:project/@harness/'+expected.decision+'/native-'+expected.decision);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(expected.decision,workspace,expect.objectContaining({requestId:expect.any(String)}));
    expect(await bindWork(f,'coordination',harnesses)).toBe(expected.coordination);
    expect(await bindWork(f,'execution',harnesses)).toBe(expected.execution);
});
it('keeps the original Session and selection across a reload after a post-create failure',async()=>{
    const f=await fixture(),original=f.open();f.fault.enqueue=true;
    const {decision}=stageChoices;
    await expect(original.startRecordConversation('b',{operationId:'discussion',resources,primaryResource:resources[0],harnesses:{decision}})).rejects.toMatchObject({code:'EIO'});
    await original.quiesce();f.settings['harness-decision']='replacement';f.fault.enqueue=false;
    const reopened=new KanbanAutomationJournal(f.fs);await reopened.open();
    const started=await f.open(reopened).startRecordConversation('b',{operationId:'discussion'});
    expect(started.resourceId).toBe('/folder:project/@harness/'+decision+'/native-'+decision);
    expect(f.create).toHaveBeenCalledOnce();
});
it('requires an authorized current reselection after an explicit missing profile and keeps the operation identity',async()=>{
    const f=await fixture(),runtime=f.open(),operationId='discussion';
    await expect(runtime.startRecordConversation('b',{operationId,resources,primaryResource:resources[0],harnesses:{decision:'missing',execution:'execution-explicit'}})).rejects.toMatchObject({code:'KANBAN_HARNESS_UNAVAILABLE'});
    expect(f.create).not.toHaveBeenCalled();
    const [failed]=await runtime.recordConversations('b');
    expect(failed).toMatchObject({id:operationId,code:'KANBAN_HARNESS_UNAVAILABLE',harnessSelectionEditable:true});
    const update={operationId,harnesses:{decision:'replacement',execution:'execution-explicit'}};
    await expect(runtime.startRecordConversation('b',{...update,expectedHarnessFingerprint:'stale'})).rejects.toMatchObject({code:'DECISION_HARNESS_SELECTION_FROZEN'});
    f.board.members[0].roles=[];
    await expect(runtime.startRecordConversation('b',{...update,expectedHarnessFingerprint:failed.attentionFingerprint})).rejects.toMatchObject({code:'COORDINATOR_REQUIRED'});
    f.board.members[0].roles=['coordinator'];
    const recovery={...update,expectedHarnessFingerprint:failed.attentionFingerprint};
    const corrected=await runtime.startRecordConversation('b',recovery);
    expect(corrected).toMatchObject({id:operationId,sessionId:'native-replacement',harnesses:update.harnesses});
    expect(await runtime.startRecordConversation('b',recovery)).toMatchObject({sessionId:'native-replacement'});
    expect(f.create).toHaveBeenCalledOnce();
});


it('passes selected model and reasoning effort to the created discussion and work Sessions',async()=>{
    const f=await fixture(),runtime=f.open();
    const harnessModels=Object.fromEntries(Object.entries(stageChoices).map(([stage,id])=>[stage,{modelId:'model-'+id,reasoningEffort:'high'}]));
    await runtime.startRecordConversation('b',{operationId:'discussion',resources,primaryResource:resources[0],harnesses:stageChoices,harnessModels});
    expect(f.enqueue).toHaveBeenCalledWith(harnessModels.decision);
    expect((await runtime.recordConversations('b'))[0].harnessModels).toEqual(harnessModels);
    await bindWork(f,'coordination',stageChoices,harnessModels);
    await bindWork(f,'execution',stageChoices,harnessModels);
});

it('reports an unavailable reasoning effort before creating a discussion',async()=>{
    const f=await fixture();
    await expect(f.open().startRecordConversation('b',{operationId:'discussion',resources,primaryResource:resources[0],harnesses:stageChoices,
        harnessModels:{decision:{modelId:'model-'+stageChoices.decision,reasoningEffort:'removed'}}})).rejects.toMatchObject({code:'KANBAN_HARNESS_EFFORT_UNAVAILABLE'});
    expect(f.create).not.toHaveBeenCalled();
});

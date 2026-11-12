import {originalSession} from '../src/projects/original-execution-session';
import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {memoryChannels} from './helpers/session-channels';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanCommand} from '@nestos/kanban/contracts';
import type {SessionInstruction, IndependentCallInput} from '@nestos/llm-session/contracts';
import {createTaskFix} from '../src/kanban/task-fix';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {UserEventService} from '../src/events/service';
import type {PersonalKanbanAutomationOptions} from '../src/kanban/personal-automation';

vi.mock('../src/projects/harness-context-catalog',()=>({readContextCatalog:async()=>({value:{bindings:{binding:{id:'binding',branchId:'main',validity:'valid',revision:1,generation:1,nativeRef:{sessionId:'native-original'}}}}})}));
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(group=false) {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),journal=new KanbanAutomationJournal(fs, kanbanJournalOptions);await journal.open();
    const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){}});
    await service.create({id:'development',title:'开发',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['coordinator','worker','reviewer']}]});
    let serial=0;const command=async(command:KanbanCommand)=>service.execute('development',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('development')).revision,command});
    const target={kind:'agent' as const,id:'executor',version:'1',digest:'a'.repeat(64)};
    await command({type:'configure-automation',settings:{enabled:true,autoAccept:false,planner:{system:'nestos-published-agent',id:'executor',revision:JSON.stringify(['1','a'.repeat(64)])},executor:{system:'nestos-published-agent',id:'executor',revision:JSON.stringify(['1','a'.repeat(64)])},coordinator:{kind:'service',id:'manager'},worker:{kind:'service',id:'worker'},preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'}}});
    await command({type:'create-item',item:{id:'original',title:'Original',responsibility:'Build original',acceptance:'Verify original',externalRefs:[{system:'nestos-remote-project',id:'x1'},{system:'nestos-execution-session',id:'original-main',revision:'main-attempt'}]}});
    await command({type:'request-run',itemId:'original'});await command({type:'admit-item',itemId:'original',trigger:'manual'});
    const originalInput={title:'Original',request:{expectedSessionId:'main-attempt',expectedBranch:'main',expectedTarget:target,target,submission:{id:'main-attempt'}}} as IndependentCallInput;
    if(!group)await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'original-plan',revision:1,sealed:true,items:[{id:'original',expectedRevision:(await service.item('development','original')).item.revision,title:'Original',responsibility:'Build original',acceptance:'Verify original',assignee:{kind:'human',id:'admin'},dependsOn:[]}]}});
    if(!group)await command({type:'prepare-dispatch',itemId:'original',dispatchId:'main-attempt'});
    const calls={prepareTaskCall:vi.fn(),submitPreparedTaskCall:vi.fn(),
        inspectTaskCallSubmission:vi.fn(async()=>({executionSessionId:'original-main',submission:{task:{sessionId:'main-attempt',taskId:'root'}}})),
        list:vi.fn(async()=>[{input:originalInput,callerState:{settled:true},executionTree:{settled:true}}])};
    const prepareWork=vi.fn(async(_input:unknown)=>'Read the scoped Fix prompt');
    const submission={start:vi.fn(async()=>({sessionId:'original-main',outcome:'running' as const})),inspect:vi.fn(async()=>({sessionId:'original-main',outcome:'running' as const}))};
    const events=await UserEventService.open(fs),log=vi.fn(),channels=memoryChannels();
    const automation={submissionControl:async()=> 'cancelled',sessionChannel:channels.channel,calls,kernel:{sessionActivity:async()=>({counts:{running:0}})},collaboration:{submission,prepare:prepareWork},catalog:async()=>({entries:[{name:'Executor',target}],issues:[]}),projects:{get:async()=>({path:'/x1'}),openWorkspace:async()=>({fs,dispose:async()=>{}})}} as unknown as PersonalKanbanAutomationOptions;
    automation.originalSession=input=>originalSession(automation as never,input);
    const options={fs,service,journal,events,automation,prepareSession:vi.fn(async(id:string)=>id),log};
    const fix=createTaskFix(options),run=()=>fix.fixTask('development',{itemId:'original',operationId:'open-fix'});
    const proposal={schema:'kanban.fix-proposal/1',title:'Fix validation',responsibility:'Repair validation',acceptance:'Regression passes',type:'fix',dependencies:['original']};
    const instruction=(text='完成',id='confirm'):SessionInstruction=>({id,text,files:[],agentId:'executor',branch:'main',createdAt:1,state:'pending'});
    let proposalRevision=0;const publish=async(id:string,value=proposal)=>{const messageId='proposal-'+ ++proposalRevision;channels.report(id,messageId,{type:'proposal',content:'Fix proposal',payload:value});return messageId;};
    return {fix,run,channels,fs,service,journal,events,calls,prepareWork,options,instruction,publish,proposal,log,submission,command};
}
it('freezes the correct board, single project, original task and explicitly absent decision without replacing the main Session',async()=>{
    const f=await fixture(),fix=await f.run();await f.run();
    expect(f.submission.start).toHaveBeenCalledTimes(1);expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
    expect(f.prepareWork.mock.calls[0][0]).toMatchObject({sessionId:'original-main',context:{board:{id:'development',title:'开发'},decision:null,projects:[{system:'nestos-remote-project',id:'x1'}],task:{id:'original',acceptance:'Verify original'},fix:{scopeId:fix.id}}});
    expect((await f.service.item('development','original')).item.externalRefs).toContainEqual({system:'nestos-execution-session',id:'original-main',revision:'main-attempt'});
    expect(fix.sessionId).toBe('original-main');
});
it('creates nothing before exact confirmation, freezes once and roundtrips the fix definition and dependency through storage',async()=>{
    const f=await fixture(),fix=await f.run(),directory=await f.publish(fix.id);
    for(const text of ['未完成','“完成”','这里写完成','```\n完成\n```'])expect(await f.fix.intercept(fix.sessionId,f.instruction(text))).toBe(false);
    expect(await f.journal.get('fix-definition:'+fix.id)).toBeUndefined();
    expect((await f.service.read('development')).items).toHaveLength(1);
    expect(await f.fix.intercept(fix.sessionId,f.instruction())).toBe(true);
    const file=await f.journal.get<Record<string,unknown>>('fix-definition:'+fix.id);
    expect(file).toMatchObject({schema:'kanban.fix/1',sourceSessionId:fix.sessionId,confirmation:{messageId:'confirm',content:'完成'},board:{id:'development'},resource:{id:'x1'},type:'fix',dependencies:['original']});
    const created=(await f.service.read('development')).items.find(item=>item.planning?.kind==='fix')!;
    expect(created).toMatchObject({status:'backlog',title:f.proposal.title,planning:{dependencies:['original']}});
    expect(created.launch!.startAt-created.createdAt).toBe(300000);expect('fixOf' in created).toBe(false);
    expect((await f.service.query('development',{view:'all',kind:'fix'})).items[0].task?.phase).toBe('waiting-dependency');
    await f.fix.intercept(fix.sessionId,f.instruction());await createTaskFix(f.options).scan();
    expect((await f.service.read('development')).items).toHaveLength(2);
    expect((await f.events.listNotifications()).items.filter(row=>row.event.value.type==='kanban.fix.accepted')).toHaveLength(1);
    expect(await f.fix.intercept(fix.sessionId,f.instruction('new definition','later'))).toBe(false);
});
it('retains the confirmation snapshot and original operation after a journal write failure and recovers without rereading later proposal edits',async()=>{
    const f=await fixture(),fix=await f.run(),directory=await f.publish(fix.id);
    const original=f.journal.update.bind(f.journal);let fail=true;
    vi.spyOn(f.journal,'update').mockImplementation(async(key,change)=>{if(fail&&key.startsWith('fix-definition:'))throw Object.assign(new Error('Disk failed'),{code:'EIO'});return original(key,change);});
    await expect(f.fix.intercept(fix.sessionId,f.instruction())).rejects.toMatchObject({code:'EIO'});
    expect((await f.service.read('development')).items).toHaveLength(1);
    await f.publish(fix.id,{...f.proposal,title:'Later input'});
    fail=false;await createTaskFix(f.options).scan();
    const task=(await f.service.read('development')).items.find(item=>item.planning?.kind==='fix')!;expect(task.title).toBe(f.proposal.title);
    expect((await f.journal.get<Record<string,unknown>>('fix-definition:'+fix.id))!.title).toBe(f.proposal.title);
});
it('repairs notification failure after the business commit without a duplicate task or false acknowledgement',async()=>{
    const f=await fixture(),fix=await f.run(),directory=await f.publish(fix.id),transaction=f.events.journal.transaction.bind(f.events.journal);
    let fail=true;vi.spyOn(f.events.journal,'transaction').mockImplementation(async(fn)=>{if(fail)throw new Error('Notify unavailable');return transaction(fn);});
    await expect(f.fix.intercept(fix.sessionId,f.instruction())).rejects.toThrow('Notify unavailable');
    expect((await f.service.read('development')).items).toHaveLength(2);expect(f.channels.ensure(fix.id).acks.has(directory)).toBe(false);
    fail=false;await createTaskFix(f.options).scan();expect((await f.service.read('development')).items).toHaveLength(2);
    expect(f.channels.ensure(fix.id).acks.has(directory)).toBe(true);
});
it('refuses a proposal that omits the original prerequisite and never guesses another board or project',async()=>{
    const f=await fixture(),fix=await f.run();await f.publish(fix.id,{...f.proposal,dependencies:[]});
    await expect(f.fix.intercept(fix.sessionId,f.instruction())).rejects.toMatchObject({code:'FIX_DEPENDENCY_REQUIRED'});
    expect((await f.service.read('development')).items).toHaveLength(1);
});

it('uses the original associated decision snapshot and content even when the current decision has changed',async()=>{
    const f=await fixture(),board=await f.service.read('development');
    await f.service.execute('development',{operationId:'decision-link',expectedRevision:board.revision,command:{type:'link-reference',itemId:'original',reference:{system:'nestos-decision-run',id:'decision-run'}}});
    await f.journal.update('record-context:decision-run',()=>({sourceBoardId:'development',recordId:'decision',recordRevision:3,runId:'decision-run'}));
    await f.journal.update('record-runs:development',()=>[{id:'decision-run',record:{id:'decision',revision:3,title:'Approved decision',content:'Original approved scope',kind:'decision',status:'confirmed'}}]);
    await f.run();expect(f.prepareWork.mock.calls[0][0]).toMatchObject({context:{decision:{recordId:'decision',recordRevision:3,record:{content:'Original approved scope'}}}});
});
it('consumes fix clarifications through the channel and repairs their receipts without blocking the original main execution',async()=>{
    const f=await fixture(),fix=await f.run();
    f.channels.report(fix.id,'fix-question',{type:'clarification',content:'Which regression should the new fix cover?'});
    await createTaskFix(f.options).scan();await createTaskFix(f.options).scan();
    expect((await f.service.item('development','original')).item.blocked).toBeUndefined();
    expect(f.channels.ensure(fix.id).acks.has('fix-question')).toBe(true);
    expect((await f.events.listNotifications()).items.filter(row=>row.event.value.type==='kanban.fix.clarification')).toHaveLength(1);
});

it('abandons an unconfirmed fix without creating a task, preserves the original execution and rejects late confirmation after restart',async()=>{
    const f=await fixture(),fix=await f.run();await f.publish(fix.id);
    const original=(await f.service.item('development','original')).item;
    f.options.automation.collaboration!.submission.inspect=async()=>({sessionId:fix.sessionId,outcome:'cancelled'});
    f.calls.list.mockResolvedValue([{input:{request:{submission:{id:fix.id}}},callerState:{settled:true},executionTree:{settled:true}}] as never);
    expect(await f.fix.cancelFix('development',{fixId:fix.id,operationId:'abandon'})).toMatchObject({state:'cancelled'});
    await createTaskFix(f.options).scan();
    expect((await f.service.read('development')).items).toHaveLength(1);
    expect((await f.service.item('development','original')).item).toEqual(original);
    expect(await createTaskFix(f.options).intercept(fix.sessionId,f.instruction())).toBe(false);
    expect(await f.fix.taskFixes('development','original')).toMatchObject([{id:fix.id,state:'cancelled'}]);
});

it('cancels an already created fix after interrupted acceptance instead of leaving it eligible to start',async()=>{
    const f=await fixture(),fix=await f.run();await f.publish(fix.id);
    const original=f.events.journal.transaction.bind(f.events.journal);
    f.events.journal.transaction=async fn=>original(async tx=>fn({...tx,append:async()=>{throw new Error('Notify unavailable');}}));
    await expect(f.fix.intercept(fix.sessionId,f.instruction())).rejects.toThrow('Notify unavailable');
    f.events.journal.transaction=original;
    f.options.automation.collaboration!.submission.inspect=async()=>({sessionId:fix.sessionId,outcome:'cancelled'});
    f.calls.list.mockResolvedValue([{input:{request:{submission:{id:fix.id}}},callerState:{settled:true},executionTree:{settled:true}}] as never);
    expect(await f.fix.cancelFix('development',{fixId:fix.id,operationId:'abandon-partial'})).toMatchObject({state:'cancelling'});
    const created=(await f.service.read('development')).items.find(item=>item.id!=='original')!;
    expect(created.control?.action).toBe('cancel');
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[]}},f.journal),f.journal,await f.service.read('development'),f.service);
    await createTaskFix(f.options).scan();
    expect((await f.fix.taskFixes('development','original'))[0].state).toBe('cancelled');
    expect((await f.service.item('development',created.id)).item.status).toBe('cancelled');
    expect((await f.service.read('development')).items).toHaveLength(2);
});

it('continues the group planning Session and appends confirmed children without changing existing work',async()=>{
    const f=await fixture(true),original=(await f.service.item('development','original')).item;
    await f.command({type:'create-item',item:{id:'existing-child',title:'Existing',responsibility:'Existing work',acceptance:'Verify'},planning:{kind:'subtask',parentId:original.id,priority:2,dependencies:[],references:[]}});
    await f.journal.update('analysis-current:'+JSON.stringify(['development',original.id]),()=> 'group-analysis');
    const input=(await f.calls.list())[0].input;
    await f.journal.update('group-analysis',()=>({id:'main-attempt',input,status:{state:'ready',itemId:original.id}}));
    const before=(await f.service.item('development','existing-child')).item,fix=await f.run();
    expect(fix.sessionId).toBe('original-main');
    f.channels.report(fix.id,'addition',{type:'proposal',content:'Append one task',payload:{schema:'kanban.coordination-proposal/1',type:'append',tasks:[{key:'mail',title:'Mail',responsibility:'Integrate mail',acceptance:'Verified',dependsOn:['existing-child']}]}});
    expect((await f.service.query('development',{view:'all',parentId:original.id})).total).toBe(1);
    const {coordinationProposal}=await import('../src/kanban/coordination-proposal');
    const saved=await f.journal.get<any>('fix:'+fix.id);
    const currentBoard=await f.service.read('development');
    expect(()=>coordinationProposal({schema:'kanban.coordination-proposal/1',type:'append',tasks:[{key:undefined,title:'Bad',responsibility:'Bad',acceptance:'Bad',dependsOn:[]}]},saved,currentBoard)).toThrow();
    await f.fix.intercept(fix.sessionId,f.instruction());
    const page=await f.service.query('development',{view:'all',parentId:original.id});expect(page.total).toBe(2);
    expect((await f.service.item('development','existing-child')).item).toEqual(before);
    const child=page.items.find(item=>item.id!==before.id)!;expect(child.planning.dependencies).toEqual(['existing-child']);
    expect(child.externalRefs).toContainEqual({system:'nestos-remote-project',id:'x1'});
    expect(await f.fix.intercept(fix.sessionId,f.instruction('continue discussion','later'))).toBe(false);
});

it('creates a repair only from the confirmed group Session proposal and atomically gates the failed child',async()=>{
 const f=await fixture(true),parent=(await f.service.item('development','original')).item;
 await f.command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'children',revision:1,sealed:true,rootItemId:parent.id,items:[{id:'failed-child',title:'Verify delivery',responsibility:'Check release',acceptance:'Expected version',workType:'subtask',assignee:{kind:'human',id:'admin'},dependsOn:[]}]}});
 await f.command({type:'prepare-dispatch',itemId:'failed-child',dispatchId:'failed-child-run'});const dispatch=(await f.service.workflow('development')).dispatches['failed-child-run'];
 await f.command({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'failed',code:'VERIFICATION_FAILED'});
 await f.journal.update('analysis-current:'+JSON.stringify(['development',parent.id]),()=> 'group-analysis');
 const originalInput=(await f.calls.list())[0].input;await f.journal.update('group-analysis',()=>({id:'main-attempt',input:originalInput,status:{state:'ready',itemId:parent.id}}));
 const fix=await f.run();expect(fix.sessionId).toBe('original-main');
 f.channels.report(fix.id,'repair-proposal',{type:'proposal',content:'Repair delivery before recheck',payload:{schema:'kanban.coordination-proposal/1',type:'repair',repairItemId:'failed-child',tasks:[{key:'delivery',title:'Repair delivery',responsibility:'Correct delivery evidence',acceptance:'Formal receipt',dependsOn:[]}]}});
 expect((await f.service.query('development',{view:'all',parentId:parent.id})).total).toBe(1);
 await f.fix.intercept(fix.sessionId,f.instruction());
 const page=await f.service.query('development',{view:'all',parentId:parent.id}),repair=page.items.find(row=>row.id!=='failed-child')!;
 expect(page.total).toBe(2);expect(repair.planning.parentId).toBe(parent.id);
 expect((await f.service.item('development','failed-child')).item).toMatchObject({planning:{dependencies:[repair.id]},repairPending:{itemId:repair.id,previousDispatchId:dispatch.id}});
 expect((await f.service.workflow('development')).dispatches[dispatch.id].outcome).toBe('failed');
 expect(await f.journal.get('repair-resumption:'+fix.id)).toMatchObject({boardId:'development',itemId:'failed-child',done:false});
 await f.fix.intercept(fix.sessionId,f.instruction());expect((await f.service.query('development',{view:'all',parentId:parent.id})).total).toBe(2);
});

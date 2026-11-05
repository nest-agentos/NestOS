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

const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),journal=new KanbanAutomationJournal(fs, kanbanJournalOptions);await journal.open();
    const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){}});
    await service.create({id:'development',title:'开发',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['coordinator','worker','reviewer']}]});
    let serial=0;const command=async(command:KanbanCommand)=>service.execute('development',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('development')).revision,command});
    const target={kind:'agent' as const,id:'executor',version:'1',digest:'a'.repeat(64)};
    await command({type:'configure-automation',settings:{enabled:true,autoAccept:false,planner:{system:'nestos-published-agent',id:'executor',revision:JSON.stringify(['1','a'.repeat(64)])},executor:{system:'nestos-published-agent',id:'executor',revision:JSON.stringify(['1','a'.repeat(64)])},coordinator:{kind:'service',id:'manager'},worker:{kind:'service',id:'worker'},preparation:{system:'nestos-work-preparation',id:'git-worktree',revision:'1'}}});
    await command({type:'create-item',item:{id:'original',title:'Original',responsibility:'Build original',acceptance:'Verify original',externalRefs:[{system:'nestos-remote-project',id:'x1'},{system:'nestos-execution-session',id:'original-main',revision:'main-attempt'}]}});
    await command({type:'request-run',itemId:'original'});await command({type:'admit-item',itemId:'original',trigger:'manual'});
    const submitted=new Map<string,IndependentCallInput>();
    const calls={prepareTaskCall:vi.fn(async()=>({})),submitPreparedTaskCall:vi.fn(async(input:IndependentCallInput)=>{submitted.set(input.request.submission!.id,input);}),
        inspectTaskCallSubmission:vi.fn(async(input:IndependentCallInput)=>submitted.has(input.request.submission!.id)?{executionSessionId:'execution-'+input.request.submission!.id,submission:{task:{sessionId:input.request.expectedSessionId,taskId:'root'}}}:undefined),
        list:vi.fn(async({sessionId}:{sessionId:string})=>[{input:submitted.get(sessionId),callerState:{settled:false}}])};
    const prepareWork=vi.fn(async(input:{dispatch:{id:string}})=>({target,contextRef:{scopeId:input.dispatch.id,sections:['context','task-fix-pre.md']}})),events=await UserEventService.open(fs),log=vi.fn();
    const channels=memoryChannels();
    const automation={sessionChannel:channels.channel,calls,kernel:{},prepareWork,catalog:async()=>({entries:[{name:'Executor',target}],issues:[]}),projects:{get:async()=>({path:'/x1'}),openWorkspace:async()=>({fs,dispose:async()=>{}})}} as unknown as PersonalKanbanAutomationOptions;
    const options={fs,service,journal,events,automation,prepareSession:vi.fn(async(id:string)=>id),log};
    const fix=createTaskFix(options),run=()=>fix.fixTask('development',{itemId:'original',operationId:'open-fix'});
    const proposal={schema:'kanban.fix-proposal/1',title:'Fix validation',responsibility:'Repair validation',acceptance:'Regression passes',type:'fix',dependencies:['original']};
    const instruction=(text='完成',id='confirm'):SessionInstruction=>({id,text,files:[],agentId:'executor',branch:'main',createdAt:1,state:'pending'});
    let proposalRevision=0;const publish=async(id:string,value=proposal)=>{const messageId='proposal-'+ ++proposalRevision;channels.report(id,messageId,{type:'proposal',content:'Fix proposal',payload:value});return messageId;};
    return {fix,run,channels,fs,service,journal,events,calls,prepareWork,options,instruction,publish,proposal,log};
}
it('freezes the correct board, single project, original task and explicitly absent decision without replacing the main Session',async()=>{
    const f=await fixture(),fix=await f.run();await f.run();
    expect(f.calls.submitPreparedTaskCall).toHaveBeenCalledTimes(1);
    expect(f.prepareWork.mock.calls[0][0]).toMatchObject({stage:'fix',context:{board:{id:'development',title:'开发'},decision:null,projects:[{system:'nestos-remote-project',id:'x1'}],task:{id:'original',acceptance:'Verify original'},fix:{scopeId:fix.id}}});
    expect((await f.service.item('development','original')).item.externalRefs).toContainEqual({system:'nestos-execution-session',id:'original-main',revision:'main-attempt'});
    expect(fix.sessionId).not.toBe('original-main');
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
    await expect(f.fix.intercept(fix.sessionId,f.instruction('new definition','later'))).rejects.toMatchObject({code:'FIX_INPUT_CLOSED'});
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
    f.calls.list.mockResolvedValue([{input:{request:{submission:{id:fix.id}}},callerState:{settled:true},executionTree:{settled:true}}] as never);
    expect(await f.fix.cancelFix('development',{fixId:fix.id,operationId:'abandon'})).toMatchObject({state:'cancelled'});
    await createTaskFix(f.options).scan();
    expect((await f.service.read('development')).items).toHaveLength(1);
    expect((await f.service.item('development','original')).item).toEqual(original);
    await expect(createTaskFix(f.options).intercept(fix.sessionId,f.instruction())).rejects.toMatchObject({code:'FIX_INPUT_CLOSED'});
    expect(await f.fix.taskFixes('development','original')).toMatchObject([{id:fix.id,state:'cancelled'}]);
});

it('cancels an already created fix after interrupted acceptance instead of leaving it eligible to start',async()=>{
    const f=await fixture(),fix=await f.run();await f.publish(fix.id);
    const original=f.events.journal.transaction.bind(f.events.journal);
    f.events.journal.transaction=async fn=>original(async tx=>fn({...tx,append:async()=>{throw new Error('Notify unavailable');}}));
    await expect(f.fix.intercept(fix.sessionId,f.instruction())).rejects.toThrow('Notify unavailable');
    f.events.journal.transaction=original;
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

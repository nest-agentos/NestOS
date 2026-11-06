import {promptData} from './helpers/prompt-data';
import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {taskReplies} from '../src/kanban/task-replies';
import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanCommand} from '@nestos/kanban/contracts';
import {scanTaskControls} from '@nestos/kanban/integration';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
vi.mock('../src/projects/harness-context-catalog',()=>({readContextCatalog:async()=>({value:{bindings:{canonical:{id:'canonical',branchId:'main',validity:'valid',revision:5,generation:1,nativeRef:{sessionId:'native-original'}}}}})}));
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture() {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
    const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),journal=new KanbanAutomationJournal(fs, kanbanJournalOptions);await journal.open();
    const actor={kind:'human' as const,id:'admin'},service=createKanbanModule({store,actor,authorize:async()=>{},log(){}});
    await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{...actor,roles:['coordinator','reviewer','worker'],responsibility:'Work'}],policy:{requireEstimate:false}});
    let serial=0;const run=async(command:KanbanCommand)=>service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:(await service.read('b')).revision,command});
    await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'t',title:'Task',responsibility:'Build',acceptance:'Verify',assignee:actor,dependsOn:[]}]}});
    await run({type:'prepare-dispatch',itemId:'t',dispatchId:'original'});
    let acknowledged=false,lose=false,unsupported=false,boundary=false;
    const calls={list:vi.fn(async()=>[{input:{request:{submission:{id:'original'}}},receipt:{executionSessionId:'original-session'},executionState:{id:'original-task',controlEpoch:2,control:{requested:boundary?'pause':'run',acknowledged:!boundary}},controlCapabilities:{pause:unsupported?'none':'boundary',resume:!unsupported,withdrawPause:true}}])};
    const control=vi.fn(async(command:string,input:{requestId:string;action:string})=>{if(lose&&command==='session.call.control')throw Object.assign(new Error('Reply lost'),{code:'ECONNRESET'});return {receipt:{current:{requestId:input.requestId,acknowledged},accepted:{requestId:input.requestId}}};});
    const scan=()=>scanTaskControls(kanbanControlOptions({calls:calls as never,callControl:control as never},journal),journal,(awaitBoard as never),service);
    let awaitBoard=await service.read('b');
    return {fs,service,journal,run,calls,control,ack:()=>{acknowledged=true;},lose:()=>{lose=true;},unsupported:()=>{unsupported=true;},boundary:()=>{boundary=true;},scan:async()=>{awaitBoard=await service.read('b');return scan();}};
}
it('distinguishes pause admission from boundary acknowledgement and resumes the original task/session/attempt',async()=>{
    const f=await fixture();await f.run({type:'request-control',itemId:'t',controlId:'pause-1',action:'pause'});await f.scan();
    expect((await f.service.item('b','t')).item.control?.state).toBe('accepted');
    expect(f.control.mock.calls[0]).toMatchObject(['session.call.control',{sessionId:'original',executionSessionId:'original-session',taskId:'original-task',requestId:'pause-1',expectedEpoch:2}]);
    f.ack();await f.scan();expect((await f.service.item('b','t')).item.control?.state).toBe('paused');
    await f.run({type:'request-control',itemId:'t',controlId:'resume-1',action:'resume'});await f.scan();
    expect((await f.service.item('b','t')).item.control?.state).toBe('resumed');
    expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(1);
    expect(f.control.mock.calls.at(-1)?.[1]).toMatchObject({sessionId:'original',executionSessionId:'original-session',taskId:'original-task',action:'resume'});
});
it('inspects the same request after a lost control reply and never submits another control on recovery',async()=>{
    const f=await fixture();f.lose();await f.run({type:'request-control',itemId:'t',controlId:'pause-lost',action:'pause'});await f.scan();
    expect((await f.service.item('b','t')).item.control?.state).toBe('unknown');
    await f.scan();expect(f.control.mock.calls.map(call=>call[0])).toEqual(['session.call.control','session.call.control.receipt']);
    expect(f.control.mock.calls[1][1]).toMatchObject({requestId:'pause-lost'});
    expect(f.control.mock.calls[1][1]).not.toHaveProperty('expectedEpoch');
});
it('reports unsupported controls as a concrete failure without creating a replacement execution',async()=>{
    const f=await fixture();f.unsupported();await f.run({type:'request-control',itemId:'t',controlId:'pause',action:'pause'});await f.scan();
    expect((await f.service.item('b','t')).item.control).toMatchObject({state:'failed',code:'TASK_CONTROL_UNSUPPORTED'});
    expect(f.control).not.toHaveBeenCalled();expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(1);
});
it('keeps duplicate control identities stable and refuses competing pending controls',async()=>{
    const f=await fixture();await f.run({type:'request-control',itemId:'t',controlId:'pause',action:'pause'});
    await f.run({type:'request-control',itemId:'t',controlId:'pause',action:'pause'});
    await expect(f.run({type:'request-control',itemId:'t',controlId:'other',action:'pause'})).rejects.toMatchObject({code:'CONTROL_UNSETTLED'});
    await f.scan();await f.scan();expect(f.control.mock.calls.filter(call=>call[0]==='session.call.control')).toHaveLength(1);
});

it('withdraws a pending boundary pause through the original control route instead of creating a replacement Session',async()=>{
    const f=await fixture();await f.run({type:'request-control',itemId:'t',controlId:'pause',action:'pause'});await f.scan();f.boundary();
    await f.run({type:'request-control',itemId:'t',controlId:'withdraw',action:'resume'});await f.scan();
    expect(f.control.mock.calls.at(-1)?.[1]).toMatchObject({action:'withdraw',executionSessionId:'original-session',taskId:'original-task'});
    expect(Object.keys((await f.service.workflow('b')).dispatches)).toEqual(['original']);
});

it('transfers a linked answer through the original Session queue, retaining a receipt after resolution',async()=>{
    const f=await fixture();await f.run({type:'observe-execution',dispatchId:'original',fence:(await f.service.workflow('b')).dispatches.original.fence,outcome:'running',executionSessionId:'original-session'});
    await f.run({type:'report-issue',itemId:'t',issue:{id:'question',attemptId:'original',type:'clarification'}});
    await f.journal.update('development-workspace:original',()=>({projectId:'x1',directory:'/workspace/work'}));
    await f.journal.update('managed-agent:work-original',()=>({target:{kind:'agent',id:'worker',version:'1',digest:'a'.repeat(64)}}));
    const enqueue=vi.fn(async()=>{}),options={calls:{inspectTaskCallSubmission:async()=>({executionSessionId:'original-session'}),list:async()=>[{receipt:{executionSessionId:'original-session'},callerState:{settled:true},executionTree:{settled:true},input:{request:{expectedSessionId:'original',expectedBranch:'main',expectedTarget:{kind:'agent',id:'worker',version:'1',digest:'a'.repeat(64)},submission:{id:'original'}}}}]},kernel:{sessionActivity:async()=>({counts:{}})},sessionChannel:vi.fn(),projects:{get:async()=>({path:'/x1'}),openWorkspace:async()=>({fs:f.fs,dispose:async()=>{}})},enqueueTaskReply:enqueue};
    const replies=taskReplies(f.service,f.journal,options as never),request={itemId:'t',attemptId:'original',replyTo:'question',operationId:'answer',content:'Use the verified input'};
    await replies('b',request);
    const source=(enqueue.mock.calls[0][0] as {source:{text:string}}).source;
    expect(promptData(source.text,'Reply binding')).toEqual({scopeId:'original',replyTo:'question',operationId:'answer'});
    expect(source.text).toContain('## User reply\n\n'+request.content);
    expect(enqueue.mock.calls[0][0]).toMatchObject({expectedSessionId:'original-session',submission:{id:'answer'},overrides:{branchMode:'continue',harnessConversation:{mode:'resume',bindingId:'canonical',expectedBindingRevision:5,expectedGeneration:1}}});
    await f.run({type:'resolve-issue',itemId:'t',attemptId:'original',issueId:'question',resolvedBy:'done'});
    await replies('b',request);await replies.scan();expect(enqueue).toHaveBeenCalledTimes(1);
    await expect(replies('b',{...request,content:'Changed'})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});

it('keeps cancellation pending after a lost reply, observes the original receipt and releases only after tree settlement',async()=>{
    const f=await fixture();
    const view={input:{request:{submission:{id:'original'}}},receipt:{executionSessionId:'original-session'},callerState:{settled:false},executionTree:{settled:false},
        executionState:{id:'original-task',controlEpoch:2,settled:false},controlCapabilities:{cancel:true,cancelRemaining:true}};
    f.calls.list.mockResolvedValue([view] as never);
    const callCancel=vi.fn(async(command:string)=>{if(command==='session.call.cancel')throw Object.assign(new Error('PRIVATE_TRANSPORT'),{code:'ECONNRESET'});return {receipt:{requestId:'cancel'}};});
    const currentScan=async()=>scanTaskControls(kanbanControlOptions({calls:f.calls as never,callCancel:callCancel as never},f.journal),f.journal,await f.service.read('b'),f.service);
    await f.run({type:'request-control',itemId:'t',controlId:'cancel',action:'cancel'});
    await currentScan();expect((await f.service.item('b','t')).item.control?.state).toBe('unknown');
    expect((await f.service.item('b','t')).item.owner).toBeDefined();
    await currentScan();expect((await f.service.item('b','t')).item.control?.state).toBe('accepted');
    expect(callCancel.mock.calls.map(row=>row[0])).toEqual(['session.call.cancel','session.call.cancellation.receipt']);
    f.calls.list.mockResolvedValue([{...view,callerState:{settled:true},executionTree:{settled:true}}] as never);
    await currentScan();expect((await f.service.item('b','t')).item.status).toBe('cancelled');
    expect((await f.service.item('b','t')).item.owner).toBeUndefined();
    expect((await f.service.workflow('b')).dispatches.original).toMatchObject({outcome:'cancelled',code:'USER_CANCELLED'});
    expect(callCancel).toHaveBeenCalledTimes(2);
});
it('never treats a missing original call route as cancellation or releases its owner',async()=>{
    const f=await fixture();f.calls.list.mockResolvedValue([]);
    await f.run({type:'request-control',itemId:'t',controlId:'cancel',action:'cancel'});
    await f.scan();await f.scan();
    expect((await f.service.item('b','t')).item.control).toMatchObject({state:'unknown',code:'TASK_CONTROL_ROUTE_MISSING'});
    expect((await f.service.item('b','t')).item.owner).toBeDefined();
    expect((await f.service.workflow('b')).dispatches.original.outcome).toBe('prepared');
});

it('reuses a previously frozen pause route after upgrading without submitting control again',async()=>{
    const f=await fixture();
    await f.run({type:'request-control',itemId:'t',controlId:'legacy-pause',action:'pause'});
    await f.journal.update('task-control:b:legacy-pause',()=>({phase:'submitting',query:{sessionId:'original',branchId:'main',callId:'original',executionSessionId:'original-session',taskId:'original-task',requestId:'legacy-pause',action:'pause',expectedEpoch:2}}));
    await f.scan();
    expect(f.control.mock.calls.map(row=>row[0])).toEqual(['session.call.control.receipt']);
    expect((await f.service.item('b','t')).item.control?.state).toBe('accepted');
});

it('settles unsent replies, maintenance and postloads in their original journals before cancelling the item',async()=>{
    const f=await fixture();
    await f.run({type:'observe-execution',dispatchId:'original',fence:(await f.service.workflow('b')).dispatches.original.fence,outcome:'failed',code:'PREPARATION_FAILED'});
    await f.journal.update('task-reply:pending',()=>({phase:'prepared',boardId:'b',request:{operationId:'pending',itemId:'t'},sessionId:'original-session'}));
    await f.journal.update('task-reply-index',()=>['pending']);
    await f.journal.update('review-operation:pending',()=>({phase:'prepared',boardId:'b',itemId:'t',id:'pending',state:'running'}));
    await f.journal.update('development-lifecycle:pending',()=>({phase:'prepared',boardId:'b',dispatch:{id:'pending',itemId:'t'}}));
    await f.run({type:'request-control',itemId:'t',controlId:'cancel-all',action:'cancel'});
    await f.scan();
    expect((await f.service.item('b','t')).item.status).toBe('cancelled');
    expect(await f.journal.get('task-reply-cancelled:pending')).toBe(true);
    expect(await f.journal.get('review-operation:pending')).toMatchObject({phase:'settled',state:'failed',code:'USER_CANCELLED'});
    expect(await f.journal.get('development-lifecycle:pending')).toMatchObject({phase:'settled',done:true,observation:{outcome:'cancelled'}});
    const enqueue=vi.fn();await taskReplies(f.service,f.journal,{enqueueTaskReply:enqueue} as never).scan();
    expect(enqueue).not.toHaveBeenCalled();expect(f.control).not.toHaveBeenCalled();
});

import {channelDigest} from '../src/run/channel-protocol';
import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore,createKanbanModule} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createTaskRecovery} from '../src/kanban/task-recovery';
import {coordinationHarnessScope,harnessPreparationKey} from '../src/presets/kanban-harness-settings';
import {taskRecoveryState} from '../src/kanban/task-recovery-state';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(group=false,active=false,missing=false,handler:'self'|'parent'='self',harnessFailure=false) {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){},verifyOutputs:async()=>true}),worker=createKanbanModule({store,actor:{kind:'service',id:'worker'},authorize:async()=>{},log(){}});
 await service.create({id:'b',title:'Work',scope:{kind:'system'},members:[{kind:'human',id:'admin',roles:['coordinator','reviewer'],responsibility:'Manage'},{kind:'service',id:'worker',roles:['worker'],responsibility:'Implement'}],policy:{requireEstimate:false,review:'independent'}});
 let serial=0;const run=async(command:any,client=service)=>client.execute('b',{operationId:'test-'+(++serial),expectedRevision:(await service.read('b')).revision,command});
 await run({type:'create-item',item:{id:'group',title:'Group',responsibility:'Coordinate',acceptance:'Delivered'},planning:{kind:'task',priority:2,dependencies:[],references:[]}});
 if(group){await run({type:'configure-automation',settings:{enabled:true,autoAccept:false,coordinator:{kind:'human',id:'admin'},worker:{kind:'service',id:'worker'},planner:{system:'external',id:'planner',revision:'1'},executor:{system:'external',id:'executor',revision:'1'}}});}
 await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,rootItemId:'group',items:[{id:'source',workType:'subtask',title:'Implementation',responsibility:'Build',acceptance:'Evidence',assignee:{kind:'service',id:'worker'},dependsOn:[],outputs:[]},{id:'verify',workType:'subtask',title:'Acceptance',responsibility:'Check',acceptance:'Actual version',...(harnessFailure?{externalRefs:[{system:'nestos-remote-project',id:'project'},{system:'nestos-decision-run',id:'stage-run'}]}:{}),assignee:{kind:'service',id:'worker'},dependsOn:['source'],outputs:[]}]}});
 await run({type:'prepare-dispatch',itemId:'source',dispatchId:'source-dispatch'},worker);let dispatch=(await service.workflow('b')).dispatches['source-dispatch'];
 await run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded',outputs:[]});await run({type:'accept-execution',dispatchId:dispatch.id,accept:true});
 await run({type:'prepare-dispatch',itemId:'verify',dispatchId:'failed-dispatch'},worker);dispatch=(await service.workflow('b')).dispatches['failed-dispatch'];
 await run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:missing?'unknown':active?'running':'failed',code:missing?'WORKSPACE_RESULT_MISSING':active?'WORKSPACE_ERROR_REPORTED':harnessFailure?'KANBAN_HARNESS_UNAVAILABLE':'VERIFICATION_RUNNING_VERSION_MISMATCH',...(harnessFailure?{}:{executionSessionId:'canonical-session'})});
 if(active)await run({type:'report-issue',itemId:'verify',issue:{id:'repository-registration-error',type:'error',attemptId:dispatch.id,handler}});
 const journal=new KanbanAutomationJournal(fs);await journal.open();const original={channelId:'failed-dispatch',projectId:'project',directory:'/workspace/worktree',context:{delivery:{readOnly:true,evidence:{operationId:'original-deploy',result:{version:'old'}}}}};
 await journal.update('development-workspace:failed-dispatch',()=>original);
 const describe=vi.fn(async()=>({id:'service',version:'current'}));const options={fs,service,journal,client:()=>service,projects:{},remote:{},describe,executionResource:vi.fn(async(id:string)=>'/native/'+id),log:vi.fn()} as any;
 const recovery=createTaskRecovery(options);closes.push(()=>recovery.quiesce());return {service,worker,journal,recovery,options,run,original};
}
it('requires explicit current-target approval and preserves successful siblings and failed history',async()=>{
 const f=await fixture(),state=await f.recovery.taskRecovery('b','verify');expect(state).toMatchObject({expectedVersion:'old',actualVersion:'current',canRetry:false,canSelectCurrentVersion:true});
 expect(state.related).toMatchObject([{itemId:'source',title:'Implementation'}]);
 await expect(f.recovery.recoverTask('b',{operationId:'unsafe',itemId:'verify',expectedRevision:state.revision,action:'retry'})).rejects.toMatchObject({code:'RECOVERY_TARGET_NOT_READY'});
 await expect(f.recovery.recoverTask('b',{operationId:'unconfirmed',itemId:'verify',expectedRevision:state.revision,action:'retry-current'})).rejects.toMatchObject({code:'RECOVERY_TARGET_NOT_READY'});
 const request={operationId:'approved',itemId:'verify',expectedRevision:state.revision,action:'retry-current' as const,confirmed:true};const result=await f.recovery.recoverTask('b',request);
 expect(result.state).toBe('accepted');expect(await f.recovery.recoverTask('b',request)).toEqual(result);
 const workflow=await f.service.workflow('b');expect(Object.values(workflow.dispatches)).toHaveLength(3);
 expect(workflow.dispatches['source-dispatch'].outcome).toBe('accepted');expect(workflow.dispatches['failed-dispatch'].outcome).toBe('failed');
 expect(workflow.dispatches[result.dispatchId!].continuation?.previousDispatchId).toBe('failed-dispatch');
 expect(await f.journal.get('development-workspace:failed-dispatch')).toEqual(f.original);
 expect(await f.journal.get('task-recovery-evidence:'+result.dispatchId)).toMatchObject({approved:true,version:'current',itemId:'verify',previousDispatchId:'failed-dispatch'});
});
it('keeps recovery pending while paused and refuses a target that changes before admission',async()=>{
 const f=await fixture();await f.run({type:'set-board-control',paused:true});const state=await f.recovery.taskRecovery('b','verify');
 const result=await f.recovery.recoverTask('b',{operationId:'paused',itemId:'verify',expectedRevision:state.revision,action:'retry-current',confirmed:true});expect(result).toMatchObject({state:'pending',code:'BOARD_EXECUTION_PAUSED'});
 expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(2);
 await f.run({type:'set-board-control',paused:false});f.options.describe.mockResolvedValue({id:'service',version:'another'});
 await f.recovery.scan();expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(2);
});
it('rejects stale recovery revisions and unrelated repair targets',async()=>{
 const f=await fixture(),state=await f.recovery.taskRecovery('b','verify');
 await expect(f.recovery.recoverTask('b',{operationId:'stale',itemId:'verify',expectedRevision:'old',action:'retry-current',confirmed:true})).rejects.toMatchObject({code:'RECOVERY_STALE_REFRESH'});
 await expect(f.recovery.recoverTask('b',{operationId:'cross',itemId:'verify',expectedRevision:state.revision,action:'fix',sourceItemId:'unrelated'})).rejects.toMatchObject({code:'RECOVERY_SCOPE_MISMATCH'});
});

it('automatically rechecks in the original execution only after the group repair is formally accepted',async()=>{
 const f=await fixture(true);f.options.describe.mockResolvedValue({id:'service',version:'old'});
 const target=(await f.service.item('b','verify')).item;
 await f.run({type:'insert-repair-dependency',itemId:'verify',expectedItemRevision:target.revision,plan:{schema:'kanban.plan/1',id:'repair',revision:1,sealed:true,mode:'append',rootItemId:'group',items:[{id:'repair',workType:'subtask',title:'Fix delivery',responsibility:'Repair receipt',acceptance:'Formal receipt',dependsOn:['source'],assignee:{kind:'service',id:'worker'},outputs:[]}]}});
 await f.journal.update('repair-resumption:group-fix',()=>({fixId:'group-fix',boardId:'b',itemId:'verify',done:false}));await f.journal.update('fix:group-fix',()=>({accepted:true}));
 await f.recovery.scan();expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(2);
 await f.run({type:'prepare-dispatch',itemId:'repair',dispatchId:'repair-run'},f.worker);let dispatch=(await f.service.workflow('b')).dispatches['repair-run'];
 await f.run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded'});await f.recovery.scan();expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(3);
 await f.run({type:'accept-execution',dispatchId:dispatch.id,accept:true});await f.recovery.scan();
 const workflow=await f.service.workflow('b'),continued=Object.values(workflow.dispatches).find(row=>row.continuation);
 expect(continued).toMatchObject({itemId:'verify',attempt:2,continuation:{previousDispatchId:'failed-dispatch'}});expect(workflow.dispatches['source-dispatch'].outcome).toBe('accepted');expect(workflow.dispatches['failed-dispatch'].outcome).toBe('failed');
 await f.recovery.scan();expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(4);
});

it('retains the canonical Session and workspace when the newest recovery failed before preparation completed',async()=>{
 const f=await fixture();const state=await f.recovery.taskRecovery('b','verify');const result=await f.recovery.recoverTask('b',{operationId:'preparation',itemId:'verify',expectedRevision:state.revision,action:'retry-current',confirmed:true});
 const dispatch=(await f.service.workflow('b')).dispatches[result.dispatchId!];await f.run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'failed',code:'WORKTREE_EXECUTION_UNKNOWN'});
 const after=await f.recovery.taskRecovery('b','verify');expect(after).toMatchObject({sessionId:'canonical-session',expectedVersion:'old',canSelectCurrentVersion:true});
 const retry=await f.recovery.recoverTask('b',{operationId:'after-preparation',itemId:'verify',expectedRevision:after.revision,action:'retry-current',confirmed:true});
 expect((await f.service.workflow('b')).dispatches[retry.dispatchId!]).toMatchObject({attempt:3,continuation:{previousDispatchId:dispatch.id}});
});

it('rechecks a formally rejected acceptance in the retained Session without changing its rejected history', async () => {
 const f=await fixture(), state=await f.recovery.taskRecovery('b','verify');
 await f.recovery.recoverTask('b',{operationId:'first',itemId:'verify',expectedRevision:state.revision,action:'retry-current',confirmed:true});
 const first=Object.values((await f.service.workflow('b')).dispatches).find(row=>row.continuation)!;
 await f.run({type:'observe-execution',dispatchId:first.id,fence:first.fence,outcome:'succeeded',outputs:[],executionSessionId:'canonical-session'});
 await f.run({type:'accept-execution',dispatchId:first.id,accept:false});
 await f.journal.update('development-workspace:'+first.id,()=>({...f.original,context:{delivery:{readOnly:true,evidence:{result:{version:'current'}}}}}));
 const rejected=await f.recovery.taskRecovery('b','verify');expect(rejected.canRetry).toBe(true);
 await f.recovery.recoverTask('b',{operationId:'second',itemId:'verify',expectedRevision:rejected.revision,action:'retry'});
 const attempts=Object.values((await f.service.workflow('b')).dispatches);
 expect(attempts.find(row=>row.id===first.id)?.outcome).toBe('rejected');
 expect(attempts.find(row=>row.attempt===3)).toMatchObject({continuation:{previousDispatchId:first.id},outcome:'prepared'});
 expect(attempts.find(row=>row.itemId==='source')?.outcome).toBe('accepted');
});

it('returns strict JSON channel values before the first persistence round trip', async()=>{
 const f=await fixture();f.options.executionResource.mockResolvedValue(undefined);
 const state=await f.recovery.taskRecovery('b','verify');
 expect(()=>channelDigest(state)).not.toThrow();
 expect(state).not.toHaveProperty('sessionId',undefined);
 expect(state).not.toHaveProperty('deliveryOperationId');
 expect(state.related[0]).not.toHaveProperty('resourceId');
});

it('keeps an active blocked execution out of failed-task recovery and opens it without injecting recovery instructions',async()=>{
 const f=await fixture(false,true);
 const state=await f.recovery.taskRecovery('b','verify');
 expect(state).toMatchObject({state:'blocked',pendingIssueIds:['repository-registration-error'],sessionId:'canonical-session',canRetry:false,canSelectCurrentVersion:false});
 expect(f.options.describe).not.toHaveBeenCalled();expect(()=>channelDigest(state)).not.toThrow();
 const projectConversation=vi.fn();f.options.remote.projectConversation=projectConversation;
 expect(await f.recovery.openTaskRecovery('b',{itemId:'verify',operationId:'open-blocked'})).toMatchObject({state:'accepted',resourceId:'/native/canonical-session'});
 expect(projectConversation).not.toHaveBeenCalled();
 expect(await f.journal.get('task-recovery-session:failed-dispatch')).toBeUndefined();
 expect((await f.service.workflow('b')).dispatches['failed-dispatch'].outcome).toBe('running');
 await expect(f.recovery.recoverTask('b',{itemId:'verify',operationId:'retry-blocked',expectedRevision:state.revision,action:'retry'})).rejects.toMatchObject({code:'RECOVERY_TARGET_NOT_READY'});
});

it('reports missing tools, then rechecks after manual installation and continues the original failed dispatch',async()=>{
 const f=await fixture();
 await f.run({type:'link-reference',itemId:'verify',reference:{system:'nestos-remote-project',id:'project'}});
 await f.journal.update('development-workspace:failed-dispatch',()=>({...f.original,context:{}}));
 f.options.recheck={supports:()=>true,run:vi.fn().mockResolvedValueOnce(['tool:pnpm']).mockResolvedValueOnce([])};
 const state=await f.recovery.taskRecovery('b','verify');
 expect(state).toMatchObject({canRecheck:true,canRetry:false,sessionId:'canonical-session'});
 const request={itemId:'verify',expectedRevision:state.revision,action:'recheck' as const};
 const first={...request,operationId:'before-install'};
 const blocked=await f.recovery.recoverTask('b',first);
 expect(blocked).toMatchObject({state:'blocked',code:'WORKSPACE_PREREQUISITES_MISSING',missing:['tool:pnpm']});
 expect((await f.service.workflow('b')).dispatches['failed-dispatch'].outcome).toBe('failed');
 expect(Object.keys((await f.service.workflow('b')).dispatches)).toHaveLength(2);
 expect(await f.recovery.recoverTask('b',first)).toEqual(blocked);
 const after=await f.recovery.recoverTask('b',{...request,operationId:'after-install'});
 expect(after.state).toBe('accepted');
 expect((await f.service.workflow('b')).dispatches[after.dispatchId!]).toMatchObject({attempt:2,continuation:{previousDispatchId:'failed-dispatch'}});
 expect(f.options.recheck.run).toHaveBeenCalledTimes(2);
});

it.each(['self','parent'] as const)('rechecks a %s blocker and replies to the original issue without clearing it or creating a dispatch',async(handler)=>{
 const f=await fixture(false,true,false,handler);
 await f.run({type:'link-reference',itemId:'verify',reference:{system:'nestos-remote-project',id:'project'}});
 await f.journal.update('development-workspace:failed-dispatch',()=>({...f.original,context:{}}));
 const replyTask=vi.fn(async(_board:string,request:{operationId:string})=>{await f.journal.update('task-reply-delivered:'+request.operationId,()=>true);});
 f.options.client=()=>({...f.service,replyTask});
 f.options.recheck={supports:()=>true,run:vi.fn().mockResolvedValueOnce(['tool:npm']).mockResolvedValueOnce([])};
 const state=await f.recovery.taskRecovery('b','verify');
 expect(state).toMatchObject({state:'blocked',canRecheck:true});
 const request={itemId:'verify',expectedRevision:state.revision,action:'recheck' as const};
 if(handler==='parent'){
    expect(await taskRecoveryState(f.options,'b','verify','session')).not.toHaveProperty('canRecheck');
    f.options.service=f.worker;
    expect(await f.recovery.taskRecovery('b','verify')).not.toHaveProperty('canRecheck');
    await expect(f.recovery.recoverTask('b',{...request,operationId:'worker-recheck'})).rejects.toMatchObject({code:'RECOVERY_TARGET_NOT_READY'});
    f.options.service=f.service;
 }
 expect(await f.recovery.recoverTask('b',{...request,operationId:'missing'})).toMatchObject({state:'blocked',missing:['tool:npm']});
 expect(replyTask).not.toHaveBeenCalled();
 const ready={...request,operationId:'available'};
 expect(await f.recovery.recoverTask('b',ready)).toMatchObject({state:'accepted'});
 expect(await f.recovery.recoverTask('b',ready)).toMatchObject({state:'accepted'});
 expect(replyTask).toHaveBeenCalledExactlyOnceWith('b',expect.objectContaining({itemId:'verify',attemptId:'failed-dispatch',replyTo:'repository-registration-error'}));
 const item=(await f.service.item('b','verify')).item;
 expect(item.issues?.find(issue=>issue.id==='repository-registration-error')?.resolvedBy).toBeUndefined();
 expect(Object.keys((await f.service.workflow('b')).dispatches)).toHaveLength(2);
});

it('rechecks report delivery on the same dispatch without admitting another execution',async()=>{
    const f=await fixture(false,true);
    const code='SOFTWARE_REPORT_BUDGET_EXCEEDED';
    await f.run({type:'link-reference',itemId:'verify',reference:{system:'nestos-remote-project',id:'project'}});
    await f.journal.update('delivery-blocked:failed-dispatch',()=>({code:'ECANCELLED',
        issues:[{id:'delivery-'+code,code},{id:'delivery-ECANCELLED',code:'ECANCELLED'}]}));
    const handoff=vi.fn(async()=>{}).mockRejectedValueOnce(Object.assign(Error('Disconnected'),{code:'ECANCELLED'})),wake=vi.fn();
    f.options.reportHandoff={run:handoff,wake};
    f.options.executionResource.mockResolvedValue('/folder:cx1/@harness/codex/native');
    const state=await f.recovery.taskRecovery('b','verify');
    expect(state).toMatchObject({reportHandoff:{code,canRecheck:true,
        reportResourceId:'/folder:cx1/@files/worktree/_nestos/kanban'},canRetry:false});
    const request={operationId:'report-recheck',itemId:'verify',expectedRevision:state.revision,action:'recheck' as const};
    const result=await f.recovery.recoverTask('b',request);
    expect(result).toMatchObject({state:'pending',code:'ECANCELLED'});
    expect(await f.recovery.recoverTask('b',request)).toEqual(result);
    expect(handoff).toHaveBeenCalledExactlyOnceWith('b','verify','failed-dispatch');
    await expect(f.recovery.recoverTask('b',{...request,operationId:'unrelated',action:'reconcile-report'})).rejects.toMatchObject({code:'RECOVERY_SCOPE_MISMATCH'});
    await expect(f.recovery.recoverTask('b',{...request,action:'reconcile-report'})).resolves.toMatchObject({
        operationId:request.operationId,state:'pending',code:'REPORT_HANDOFF_SETTLEMENT_PENDING'});
    expect(handoff).toHaveBeenLastCalledWith('b','verify','failed-dispatch',true);
    expect(wake).toHaveBeenCalledTimes(2);
    expect(Object.values((await f.service.workflow('b')).dispatches)).toHaveLength(2);
});


it('requests formal result recovery in the original session without dispatching new work', async()=>{
 const f=await fixture(false,false,true);
 const resourceId='/folder:project/@harness/profile/canonical-session';
 f.options.executionResource.mockResolvedValue(resourceId);
 const enqueue=vi.fn(async()=>{}),close=vi.fn(async()=>{});
 f.options.remote.projectHarness=vi.fn(async()=>({subscribeChannel:()=>()=>{},close}));
 f.options.remote.projectConversation=vi.fn(async()=>({enqueue,close}));
 let scopeId='newer-dispatch',messages:unknown[]=[],turn: {status?:string;turnId?:string}={};
 f.options.remote.sessionChannel=vi.fn(async(_project:string,method:string)=>{
    if(method==='current')return {scopeId,execution:{sessionId:'canonical-session',...turn}};
    if(method==='messages')return {messages};
    throw new Error('Supplemental recovery channel unavailable');
 });
 const state=await f.recovery.taskRecovery('b','verify');
 const request={itemId:'verify',operationId:'assist',expectedRevision:state.revision};
 await expect(f.recovery.openTaskRecovery('b',{...request,expectedRevision:'stale'})).rejects.toMatchObject({code:'RECOVERY_STALE_REFRESH'});
 await expect(f.recovery.openTaskRecovery('b',request)).rejects.toMatchObject({code:'RECOVERY_STALE_REFRESH'});
 expect(enqueue).not.toHaveBeenCalled();
 scopeId='failed-dispatch';
 await expect(f.recovery.openTaskRecovery('b',request)).resolves.toMatchObject({state:'accepted',resourceId});
 expect(f.options.remote.projectConversation).toHaveBeenCalledWith('project','profile','canonical-session');
 expect(enqueue).toHaveBeenCalledWith(expect.stringContaining('Complete remaining authorized work'),[],undefined,'recovery-result-v2-failed-dispatch','next-turn');
 expect(enqueue.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('exact blocker and next action')]));
 turn={status:'running',turnId:'continuation-turn'};
 await expect(f.recovery.openTaskRecovery('b',request)).resolves.toMatchObject({state:'accepted',resourceId});
 expect(enqueue).toHaveBeenCalledOnce();
 turn={...turn,status:'completed'};
 await f.recovery.openTaskRecovery('b',request);
 await f.recovery.openTaskRecovery('b',{...request,operationId:'repeat-click'});
 const continuedId=enqueue.mock.lastCall?.[3];
 expect(continuedId).toMatch(/^recovery-result-v3-/);
 expect(enqueue.mock.calls[1]?.[3]).toBe(continuedId);
 turn={status:'completed',turnId:'later-incomplete-turn'};
 await f.recovery.openTaskRecovery('b',request);
 expect(enqueue.mock.lastCall?.[3]).not.toBe(continuedId);
 messages=[{id:'missing',message:{type:'error',content:'Evidence unavailable',payload:{handler:'parent'}}}];
 await expect(f.recovery.openTaskRecovery('b',request)).resolves.toMatchObject({state:'accepted',resourceId});
 messages=[{id:'final',message:{type:'result',content:'Verified'}}];
 await expect(f.recovery.openTaskRecovery('b',request)).resolves.toMatchObject({state:'accepted',resourceId});
 expect(enqueue).toHaveBeenCalledTimes(4);
 expect(f.options.remote.projectHarness).not.toHaveBeenCalled();
 const attempts=Object.values((await f.service.workflow('b')).dispatches).filter(row=>row.itemId==='verify');
 expect(attempts).toMatchObject([{id:'failed-dispatch',outcome:'unknown'}]);
});


it('settles only the exact completed parent-reported delivery blocker and retains the original attempt', async()=>{
 const f=await fixture(false,true,false,'parent'),resourceId='/folder:project/@harness/profile/original-native';
 f.options.executionResource.mockResolvedValue(resourceId);
 await f.run({type:'link-reference',itemId:'verify',reference:{system:'nestos-remote-project',id:'project'}});
 const turn={sessionId:'original-native',turnId:'finished-turn',operationId:'original-operation',status:'completed'};
 let execution={...turn,status:'running'};
 const blocker={id:'repository-registration-error',message:{type:'error',payload:{handler:'parent'}},origin:turn};
 let messages=[blocker] as unknown[];
 f.options.remote.sessionChannel=vi.fn(async(_project:string,action:string)=>action==='current'
    ?{scopeId:'failed-dispatch',execution}:{execution,messages});
 const state=await f.recovery.taskRecovery('b','verify');
 expect(state).toMatchObject({state:'blocked',canSettleDelivery:true});
 const request={action:'settle-delivery' as const,operationId:'settle-delivery',itemId:'verify',expectedRevision:state.revision,confirmed:true};
 await expect(f.recovery.recoverTask('b',{...request,confirmed:false})).rejects.toMatchObject({code:'RECOVERY_USER_CONFIRMATION_REQUIRED'});
 await expect(f.recovery.recoverTask('b',request)).rejects.toMatchObject({code:'DELIVERY_TURN_UNVERIFIED'});
 execution=turn;
 messages=[blocker,{id:'already-delivered',message:{type:'result'}}];
 await expect(f.recovery.recoverTask('b',request)).rejects.toMatchObject({code:'DELIVERY_RESULT_EXISTS'});
 messages=[blocker];
 expect(await f.recovery.recoverTask('b',request)).toMatchObject({state:'accepted'});
 expect(await f.recovery.recoverTask('b',request)).toMatchObject({state:'accepted'});
 const attempts=Object.values((await f.service.workflow('b')).dispatches).filter(row=>row.itemId==='verify');
 expect(attempts).toMatchObject([{id:'failed-dispatch',outcome:'failed',code:'WORKSPACE_DELIVERY_INCOMPLETE',executionSessionId:'canonical-session'}]);
 const item=(await f.service.item('b','verify')).item;
 expect(item).toMatchObject({status:'backlog',issues:[{id:blocker.id,handler:'parent'}]});
 expect(item.owner).toBeUndefined();
 expect(await f.journal.get('development-workspace:failed-dispatch')).toEqual(f.original);
});


it.each(['coordination','execution'] as const)('admits a new authorized %s target only after a versioned Harness reselection',async role=>{
 const f=await fixture(false,false,false,'self',true);
 const itemId=role==='coordination'?'planning-harness':'verify',oldProfile='removed';
 const externalRefs=[{system:'nestos-remote-project',id:'project'},{system:'nestos-decision-harness-'+role,id:oldProfile}];
 if(role==='coordination'){
    await f.run({type:'create-item',item:{id:itemId,taskType:'coordination',purpose:'planning',title:'Planning',responsibility:'Plan',acceptance:'Ready',
        externalRefs:[externalRefs[0],{system:'nestos-decision-run',id:'stage-run'}]}});
    await f.run({type:'report-analysis',itemId,operationId:'failed-planning',status:{itemId,state:'failed',code:'KANBAN_HARNESS_UNAVAILABLE'}});
 }
 await f.journal.update('record-context:stage-run',()=>({sourceBoardId:'b',recordId:'stage-decision',recordRevision:1,runId:'stage-run'}));
 await f.journal.update('record-runs:b',()=>[{id:'stage-run',boardId:'b',sourceBoardId:'b',recordId:'stage-decision',recordRevision:1,state:'running',createdAt:1,updatedAt:1,record:{externalRefs}}]);
 const failure=role==='coordination'?coordinationHarnessScope('b',itemId):'failed-dispatch';
 await f.journal.update(harnessPreparationKey(failure),()=>({projectId:'project',profileId:oldProfile,role,code:'KANBAN_HARNESS_UNAVAILABLE'}));
 const profiles=[{id:'replacement',projectRuntime:true,workspaces:[{id:'workspace'}],capabilities:{create:true,workingDirectory:true,sessionChannels:true}}];
 f.options.remote={list:()=>[{at:'/',serverProjectId:'workspace'}],projectHarness:async()=>({profiles:async()=>({profiles}),close:async()=>{}})};
 const state=await f.recovery.taskRecovery('b',itemId);
 expect(state).toMatchObject({code:'KANBAN_HARNESS_UNAVAILABLE',harnessReselection:{role,profileId:oldProfile}});
 const request={itemId,operationId:'replace-harness',expectedRevision:state.revision,action:'reselect-harness' as const,harnessProfileId:'replacement'};
 await expect(f.recovery.recoverTask('b',{...request,expectedRevision:'old'})).rejects.toMatchObject({code:'RECOVERY_STALE_REFRESH'});
 await expect(f.recovery.recoverTask('b',{...request,harnessProfileId:'removed'})).rejects.toMatchObject({code:'KANBAN_HARNESS_UNAVAILABLE'});
 const result=await f.recovery.recoverTask('b',request);
 expect(result.state).toBe('accepted');expect(await f.recovery.recoverTask('b',request)).toEqual(result);
 const target={system:'nestos-decision-harness-'+role,id:'replacement'};
 if(role==='coordination')expect((await f.service.item('b',itemId)).item.launch?.analysisPreparation).toEqual(target);
 else {
    const {dispatches}=await f.service.workflow('b');
    expect(dispatches[result.dispatchId!].continuation).toEqual({previousDispatchId:'failed-dispatch',preparation:target});
    expect(dispatches['failed-dispatch']).toMatchObject({outcome:'failed',code:'KANBAN_HARNESS_UNAVAILABLE'});
 }
});

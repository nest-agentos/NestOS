import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore,createKanbanModule} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createTaskRecovery} from '../src/kanban/task-recovery';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(group=false) {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){},verifyOutputs:async()=>true}),worker=createKanbanModule({store,actor:{kind:'service',id:'worker'},authorize:async()=>{},log(){}});
 await service.create({id:'b',title:'Work',scope:{kind:'system'},members:[{kind:'human',id:'admin',roles:['coordinator','reviewer'],responsibility:'Manage'},{kind:'service',id:'worker',roles:['worker'],responsibility:'Implement'}],policy:{requireEstimate:false,review:'independent'}});
 let serial=0;const run=async(command:any,client=service)=>client.execute('b',{operationId:'test-'+(++serial),expectedRevision:(await service.read('b')).revision,command});
 if(group){await run({type:'create-item',item:{id:'group',title:'Group',responsibility:'Coordinate',acceptance:'Delivered'},planning:{kind:'task',priority:2,dependencies:[],references:[]}});await run({type:'configure-automation',settings:{enabled:true,autoAccept:false,coordinator:{kind:'human',id:'admin'},worker:{kind:'service',id:'worker'},planner:{system:'external',id:'planner',revision:'1'},executor:{system:'external',id:'executor',revision:'1'}}});}
 await run({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,...(group?{rootItemId:'group'}:{}),items:[{id:'source',...(group?{workType:'subtask'}:{}),title:'Implementation',responsibility:'Build',acceptance:'Evidence',assignee:{kind:'service',id:'worker'},dependsOn:[],outputs:[]},{id:'verify',...(group?{workType:'subtask'}:{}),title:'Acceptance',responsibility:'Check',acceptance:'Actual version',assignee:{kind:'service',id:'worker'},dependsOn:['source'],outputs:[]}]}});
 await run({type:'prepare-dispatch',itemId:'source',dispatchId:'source-dispatch'},worker);let dispatch=(await service.workflow('b')).dispatches['source-dispatch'];
 await run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'succeeded',outputs:[]});await run({type:'accept-execution',dispatchId:dispatch.id,accept:true});
 await run({type:'prepare-dispatch',itemId:'verify',dispatchId:'failed-dispatch'},worker);dispatch=(await service.workflow('b')).dispatches['failed-dispatch'];
 await run({type:'observe-execution',dispatchId:dispatch.id,fence:dispatch.fence,outcome:'failed',code:'VERIFICATION_RUNNING_VERSION_MISMATCH',executionSessionId:'canonical-session'});
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

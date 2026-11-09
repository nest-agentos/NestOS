import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanCommand,KanbanItemOperationRequest} from '@nestos/kanban/contracts';
import {createItemOperations} from '../src/kanban/item-operations';
import {operationDependencies,affectedOperations} from '../src/kanban/item-operation-skips';
import type {ReviewOperationsOptions} from '../src/kanban/item-operation-types';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),actor={kind:'human' as const,id:'admin'};
 const service=createKanbanModule({store,actor,authorize:async()=>{},verifyOutputs:async()=>true,log(){}}),worker=createKanbanModule({store,actor:{kind:'service',id:'worker'},authorize:async()=>{},log(){}});
 await service.create({id:'b',title:'Board',scope:{kind:'system'},policy:{requireEstimate:false},members:[{...actor,responsibility:'Review',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Work',roles:['worker','coordinator']}]});
 let serial=0;const command=async(cmd:KanbanCommand,api=service)=>api.execute('b',{operationId:'seed-'+ ++serial,expectedRevision:(await api.read('b')).revision,command:cmd});
 await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'task',title:'Task',responsibility:'Work',acceptance:'Delivery',assignee:{kind:'service',id:'worker'},dependsOn:[]}]}});
 await command({type:'prepare-dispatch',itemId:'task',dispatchId:'d'},worker);
 await command({type:'observe-execution',dispatchId:'d',fence:(await service.workflow('b')).dispatches.d.fence,outcome:'succeeded'});
 const journal=new KanbanAutomationJournal(fs);await journal.open();
 const start=vi.fn(async()=>{throw Error('UNEXPECTED_SIDE_EFFECT');});
 const options={service,journal,catalog:async()=>({entries:[]}),adapter:{supports:()=>true,snapshot:vi.fn(async()=>({version:'v',sourceVersion:'s',targetVersion:'t',context:{}})),prepareOperation:start},published:{start,inspect:start},submission:{start,inspect:start},log:vi.fn()} as unknown as ReviewOperationsOptions;
 const api=createItemOperations(options);closes.push(()=>api.quiesce());
 const request=async(action:string,id=action):Promise<KanbanItemOperationRequest>=>{const view=await api.itemOperations('b','task');return {operationId:id,itemId:'task',action:'skip',expectedRevision:view.revision,confirmed:true,skip:{action,reason:'User-approved environment exception',affected:view.operations.find(row=>row.id===action)!.skip!.affected.map(row=>row.id)}};};
 return {api,options,service,worker,journal,command,request,start};
}
it('cascades the four delivery stages in canonical order even for older frozen plans',()=>{
 const runtime=operationDependencies();expect(affectedOperations(runtime,'deploy')).toEqual(['deploy','accept','analyze','merge','cleanup']);
 expect(affectedOperations(runtime,'analyze')).toEqual(['analyze','merge','cleanup']);
 const release=operationDependencies({steps:['build','deploy','analyze','merge','accept','cleanup'],acceptance:'runtime'});
 expect(affectedOperations(release,'build')).toEqual(['build','deploy','accept','analyze','merge','cleanup']);expect(release.merge).toEqual(['analyze']);
 expect(release.accept).toEqual(['deploy']);
 const source=operationDependencies({steps:['analyze','merge','cleanup'],acceptance:'source'});
 expect(affectedOperations(source,'analyze')).toEqual(['analyze','merge','cleanup']);
});
it('persists dependency skips and their actor without completing outstanding independent requirements',async()=>{
 const f=await fixture(),request=await f.request('deploy');
 const result=await f.api.runItemOperation('b',request);
 expect(result.operations.find(row=>row.id==='deploy')).toMatchObject({state:'skipped',enabled:false,waiver:{cause:'direct'}});
 expect(result.operations.find(row=>row.id==='accept')).toMatchObject({state:'skipped',waiver:{cause:'dependency'}});
 expect(result.operations.find(row=>row.id==='analyze')).toMatchObject({state:'skipped',waiver:{cause:'dependency'}});
 expect(result.operations.find(row=>row.id==='merge')).toMatchObject({dependsOn:['analyze']});expect(result.operations.find(row=>row.id==='merge')).toMatchObject({state:'skipped',waiver:{cause:'dependency'}});
 const item=(await f.service.item('b','task')).item;expect(item.status).toBe('review');
 expect(item.operationWaivers?.[0]).toMatchObject({id:'deploy',dispatchId:'d',actor:{kind:'human',id:'admin'},reason:request.skip!.reason});
 await f.api.runItemOperation('b',request);expect((await f.service.item('b','task')).item.operationWaivers).toHaveLength(1);expect(f.start).not.toHaveBeenCalled();
 await expect(f.api.runItemOperation('b',{...request,skip:{...request.skip!,reason:'Changed'}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
it('completes with waived acceptance only after every other requirement is settled and survives restart',async()=>{
 const f=await fixture();await f.api.runItemOperation('b',await f.request('deploy'));
 expect((await f.service.item('b','task')).item.status).toBe('review');
 await f.api.runItemOperation('b',await f.request('build'));
 const item=(await f.service.item('b','task')).item;expect(item.status).toBe('completed');
 expect(item.acceptanceResult).toMatchObject({outcome:'waived',dispatchId:'d',waiverId:'deploy'});
 expect((await f.service.workflow('b')).dispatches.d.outcome).toBe('accepted');
 await f.api.quiesce();const restored=createItemOperations(f.options);closes.push(()=>restored.quiesce());
 const view=await restored.itemOperations('b','task');expect(view.waiverHistory).toHaveLength(2);expect(view.acceptance?.outcome).toBe('waived');
 expect(f.start).not.toHaveBeenCalled();
});
it.each(['reason','confirmation','impact','revision'])('rejects invalid skip %s without modifying task records',async field=>{
 const f=await fixture(),request=await f.request('deploy'),before=await f.service.item('b','task');
 if(field==='reason')request.skip!.reason=' ';if(field==='confirmation')request.confirmed=false;
 if(field==='impact')request.skip!.affected=['deploy'];if(field==='revision')request.expectedRevision='f'.repeat(64);
 await expect(f.api.runItemOperation('b',request)).rejects.toBeDefined();expect(await f.service.item('b','task')).toEqual(before);
});
it('refuses agent-authored waivers and ordinary acceptance cannot erase an existing waiver',async()=>{
 const f=await fixture();await f.api.runItemOperation('b',await f.request('deploy'));
 await expect(f.command({type:'accept-execution',dispatchId:'d',accept:true})).rejects.toMatchObject({code:'OPERATION_ACCEPTANCE_WAIVER_REQUIRED'});
 const row=(await f.service.item('b','task')).item;
 await expect(f.command({type:'waive-operations',itemId:'task',dispatchId:'d',expectedItemRevision:row.revision,waiver:{id:'agent-skip',action:'analyze',reason:'Agent suggestion',dependencies:{analyze:[]},operations:[{id:'analyze',cause:'direct',previousState:'ready'}]}},f.worker)).rejects.toMatchObject({code:'OPERATION_COORDINATOR_REQUIRED'});
});
it('retains the failed operation and rejects skipping an unsettled execution',async()=>{
 const f=await fixture();
 const failed={id:'failed-deploy',boardId:'b',itemId:'task',action:'deploy',phase:'settled',state:'failed',code:'ENVIRONMENT_REJECTED',fingerprint:'f',snapshot:{version:'v',sourceVersion:'s',targetVersion:'t',context:{}},createdAt:1};
 await f.journal.update('review-operation:failed-deploy',()=>failed);
 await f.journal.update('review-operations:'+JSON.stringify(['b','task']),()=>({revision:1,bindings:{},jobs:['failed-deploy'],receipts:{}}));
 await f.api.runItemOperation('b',await f.request('deploy'));
 expect(await f.journal.get('review-operation:failed-deploy')).toEqual(failed);
 expect((await f.service.item('b','task')).item.operationWaivers![0].operations.find(row=>row.id==='deploy')).toMatchObject({previousState:'failed',previousRunId:'failed-deploy'});
 const second=await fixture();await second.journal.update('review-operation:active',()=>({...failed,id:'active',action:'build',phase:'submitting',state:'unknown'}));
 await second.journal.update('review-operations:'+JSON.stringify(['b','task']),()=>({revision:1,bindings:{},jobs:['active'],receipts:{}}));
 const before=await second.service.item('b','task');
 await expect(second.api.runItemOperation('b',{operationId:'blocked',itemId:'task',action:'skip',expectedRevision:(await second.api.itemOperations('b','task')).revision,confirmed:true,skip:{action:'deploy',reason:'Cannot abandon unknown execution',affected:['deploy','accept','analyze','merge','cleanup']}})).rejects.toMatchObject({code:'OPERATION_IN_USE'});
 expect(await second.service.item('b','task')).toEqual(before);
});
it('rejects a forged incomplete dependency closure atomically in the domain command',async()=>{
 const f=await fixture(),before=await f.service.item('b','task');
 await expect(f.command({type:'waive-operations',itemId:'task',dispatchId:'d',expectedItemRevision:before.item.revision,waiver:{id:'incomplete',action:'first',reason:'Explicit exception',dependencies:{first:[],second:['first']},operations:[{id:'first',cause:'direct',previousState:'ready'}]}})).rejects.toMatchObject({code:'OPERATION_SKIP_INVALID'});
 expect(await f.service.item('b','task')).toEqual(before);
});

it('refuses skip metadata on an ordinary executable action so older hosts cannot misinterpret a waiver',async()=>{
 const f=await fixture(),request=await f.request('deploy');
 expect(()=>f.api.runItemOperation('b',{...request,action:'deploy'})).toThrowError('OPERATION_REQUEST_INVALID');expect(f.start).not.toHaveBeenCalled();
});
it('recovers an acknowledged-lost domain commit by its original receipt without duplicating the waiver',async()=>{
 const f=await fixture(),request=await f.request('deploy'),execute=f.service.execute;
 const spy=vi.spyOn(f.service,'execute').mockImplementationOnce(async(board,input)=>{await execute(board,input);throw Object.assign(new Error('Lost acknowledgement'),{code:'TRANSPORT_DISCONNECTED'});});
 await expect(f.api.runItemOperation('b',request)).rejects.toMatchObject({code:'TRANSPORT_DISCONNECTED'});
 expect((await f.service.item('b','task')).item.operationWaivers).toHaveLength(1);
 spy.mockRestore();await f.api.scan();await f.api.runItemOperation('b',request);
 expect((await f.service.item('b','task')).item.operationWaivers).toHaveLength(1);expect(f.start).not.toHaveBeenCalled();
});

it('retains historical waivers but does not hide or complete a still unconfirmed analysis',async()=>{
 const f=await fixture(),before=(await f.service.item('b','task')).item;
 await f.command({type:'waive-operations',itemId:'task',dispatchId:'d',expectedItemRevision:before.revision,waiver:{id:'legacy-build',action:'build',reason:'Historical waiver',acceptanceWaived:true,dependencies:{build:[],deploy:['build'],analyze:[],merge:['analyze','deploy'],accept:['merge'],cleanup:['accept']},operations:['build','deploy','merge','accept','cleanup'].map(id=>({id,cause:id==='build'?'direct':'dependency',previousState:'unavailable'}))}} as KanbanCommand);
 const history=(await f.service.item('b','task')).item.operationWaivers;
 await f.journal.update('review-operation:legacy-analysis',()=>({id:'legacy-analysis',boardId:'b',itemId:'task',action:'analyze',phase:'submitting',state:'unknown',snapshot:{},fingerprint:'original',createdAt:1,sessionId:'original'}));
 await f.journal.update('review-operations:'+JSON.stringify(['b','task']),()=>({revision:1,bindings:{},jobs:['legacy-analysis'],receipts:{}}));
 const view=await f.api.itemOperations('b','task');
 expect(view.operations.find(row=>row.id==='analyze')).toMatchObject({state:'unknown',sessionId:'original',enabled:false,progress:{stage:'reconciling'}});
 expect(view.skippedActions).not.toContain('analyze');expect(view.waiverHistory).toEqual(history);
 expect((await f.service.item('b','task')).item.status).toBe('review');expect(f.start).not.toHaveBeenCalled();
});

import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {automaticDelivery} from '../src/kanban/automatic-delivery';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const item={id:'task',status:'review',planning:{kind:'task'}},board={id:'b',automation:{enabled:true},items:[item]},jobs=new Map<string,any>();
 const run=vi.fn(async(_board,request)=>{jobs.set(request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});if(request.action==='accept')item.status='completed';return {revision:'revision',operations:[...jobs.values()]};});
 const view=vi.fn(async()=>({revision:'revision',operations:['build','deploy','accept','analyze','merge'].map(id=>jobs.get(id)??{id,enabled:true,state:'ready'})}));
 const options={service:{catalog:async()=>[{id:'b'}],read:async()=>board,item:async(_board,id)=>({item:board.items.find(row=>row.id===id)}),workflow:async()=>({dispatches:{d:{id:'d',itemId:'task',attempt:1,outcome:'succeeded'}}})},journal,active:()=>true,automatic:async()=>true,view,run,cleanup:vi.fn(async()=>true),report:vi.fn()} as any;
 return {options,journal,run,jobs,item,board};}
it('resumes all approved stages once and releases dependencies only after verified cleanup',async()=>{const f=await fixture();
 for(let n=0;n<12;n++){await automaticDelivery(f.options).scan();if(n<10)expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);}
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build','deploy','accept','analyze','merge']);expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledTimes(5);
});
it('never repeats an unknown operation and blocks at unapproved conflict choices',async()=>{const f=await fixture();await automaticDelivery(f.options).scan();
 f.jobs.get('build').state='unknown';for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();f.jobs.get('build').state='succeeded';
 for(let n=0;n<7;n++)await automaticDelivery(f.options).scan();
 f.options.view=async()=>({revision:'revision',operations:[...f.jobs.values(),{id:'merge',enabled:true,fields:[{id:'conflict'}]}]});await automaticDelivery(f.options).scan();
 expect(f.options.report).toHaveBeenCalledWith(expect.objectContaining({code:'OPERATION_SELECTION_REQUIRED'}));expect(f.run.mock.calls.some(call=>call[1].action==='merge')).toBe(false);
});

it('cleans completed task groups without creating a second build or deployment',async()=>{const f=await fixture();
 f.item.status='completed';(f.item.planning as any).execution='children';f.options.service.workflow=async()=>({dispatches:{}});
 f.options.cleanup.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
 await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);expect(f.run).not.toHaveBeenCalled();
});

it('waits for a user-confirmed conflict resolution and cleans only after its verified merge',async()=>{
 const f=await fixture();for(let n=0;n<8;n++)await automaticDelivery(f.options).scan();
 f.options.view=async()=>({revision:'r',operations:[...f.jobs.values(),{id:'merge',enabled:true,fields:[{id:'conflict'}]}]});
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();expect(f.options.cleanup).not.toHaveBeenCalled();
 f.options.view=async()=>({revision:'r',operations:[{id:'merge',state:'running',runId:'user-merge'}]});await automaticDelivery(f.options).scan();expect(f.options.cleanup).not.toHaveBeenCalled();
 f.options.view=async()=>({revision:'r',operations:[{id:'merge',state:'succeeded',runId:'user-merge'}]});await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 expect(f.run.mock.calls.some(call=>call[1].action==='merge')).toBe(false);
});

it('adopts a verified manual rebuild after a failure without replaying the failed automatic request',async()=>{
 const f=await fixture();await automaticDelivery(f.options).scan();f.jobs.get('build').state='failed';await automaticDelivery(f.options).scan();
 f.jobs.set('build',{id:'build',runId:'confirmed-manual-rebuild',state:'succeeded',enabled:true});await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['build','deploy']);
});

it('serializes finalization for the same target while leaving development independent',async()=>{
 const f=await fixture(),second={...f.item,id:'second'};f.board.items.push(second);f.options.target=()=> 'project';
 f.options.service.workflow=async()=>({dispatches:{a:{id:'a',itemId:'task',attempt:1,outcome:'succeeded'},b:{id:'b',itemId:'second',attempt:1,outcome:'succeeded'}}});
 const jobs=new Map<string,any>();f.options.view=async(_b,id)=>({revision:'r',operations:['build','deploy','accept','analyze','merge'].map(action=>jobs.get(id+action)??{id:action,enabled:true,state:'ready'})});
 f.options.run=vi.fn(async(_b,request)=>{jobs.set(request.itemId+request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});if(request.action==='accept')f.board.items.find(row=>row.id===request.itemId)!.status='completed';});
 await automaticDelivery(f.options).scan();await automaticDelivery(f.options).scan();expect(f.options.run.mock.calls.map(call=>call[1].itemId)).toEqual(['task']);
 for(let n=0;n<10;n++)await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledWith('b','task',expect.any(String));expect(f.options.run.mock.calls.some(call=>call[1].itemId==='second')).toBe(true);
});

it('retains target ownership until cancelled work has no unsettled admitted operation',async()=>{
 const f=await fixture();f.options.target=()=> 'project';await automaticDelivery(f.options).scan();
 f.item.status='cancelled';f.board.items.push({...f.item,id:'second',status:'review'});
 f.options.service.workflow=async()=>({dispatches:{second:{id:'second',itemId:'second',attempt:1,outcome:'succeeded'}}});
 await f.journal.update('review-operations:'+JSON.stringify(['b','task']),()=>({jobs:['held']}));await f.journal.update('review-operation:held',()=>({phase:'submitting'}));
 await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();
 await f.journal.update('review-operation:held',()=>({phase:'settled'}));f.jobs.clear();await automaticDelivery(f.options).scan();
 expect(f.run).toHaveBeenCalledTimes(2);expect(f.run.mock.calls[1][1].itemId).toBe('second');
});
it('rechecks a cleanup precondition after restart without repeating unchanged notifications',async()=>{
 const f=await fixture();f.item.status='completed';(f.item.planning as any).execution='children';let blocked=true;
 f.options.cleanup=vi.fn(async()=>{if(blocked)throw Object.assign(new Error('Cache remains'),{code:'CACHE_PENDING',cleanupPrecondition:true});return true;});
 for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();
 expect(f.options.cleanup).toHaveBeenCalledTimes(3);expect(f.options.report).toHaveBeenCalledOnce();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
 blocked=false;await automaticDelivery(f.options).scan();expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 expect(f.options.report).toHaveBeenLastCalledWith(expect.objectContaining({done:true,code:undefined}));
});
it('does not replay a cleanup effect whose outcome is unknown',async()=>{
 const f=await fixture();f.item.status='completed';(f.item.planning as any).execution='children';
 f.options.cleanup=vi.fn(async()=>{throw Object.assign(new Error('Unknown effect'),{code:'CLEANUP_OUTCOME_UNKNOWN'});});
 for(let n=0;n<3;n++)await automaticDelivery(f.options).scan();expect(f.options.cleanup).toHaveBeenCalledOnce();expect(f.options.report).toHaveBeenCalledOnce();
 expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(false);
});

it('freezes selected steps across restarts and performs only one release for an entire chain',async()=>{
 const f=await fixture();f.options.plan=async()=>({steps:['accept','analyze','merge','cleanup']});
 await automaticDelivery(f.options).scan();f.options.plan=async()=>({steps:['build','deploy','accept','analyze','merge','cleanup']});
 for(let n=0;n<8;n++)await automaticDelivery(f.options).scan();
 expect(f.run.mock.calls.map(call=>call[1].action)).toEqual(['accept','analyze','merge']);expect(await automaticDelivery(f.options).ready('b',f.item as never)).toBe(true);
 f.jobs.clear();f.item.id='release';f.item.status='review';f.options.service.workflow=async()=>({dispatches:{r:{id:'r',itemId:'release',attempt:1,outcome:'succeeded'}}});
 for(let n=0;n<12;n++)await automaticDelivery(f.options).scan();
 f.jobs.clear();f.item.id='verifier';f.item.status='review';f.options.plan=async()=>({steps:['accept','cleanup']});
 f.options.service.workflow=async()=>({dispatches:{v:{id:'v',itemId:'verifier',attempt:1,outcome:'succeeded'}}});
 for(let n=0;n<4;n++)await automaticDelivery(f.options).scan();
 const actions=f.run.mock.calls.map(call=>call[1].action);expect(actions.filter(action=>action==='build')).toHaveLength(1);expect(actions.filter(action=>action==='deploy')).toHaveLength(1);
 expect(actions.at(-1)).toBe('accept');expect(f.options.cleanup).toHaveBeenCalledTimes(3);
});
it('rechecks pause after asynchronous preparation before admitting the next step',async()=>{
 const f=await fixture(),view=f.options.view;
 f.options.view=async()=>{const result=await view();(f.board as any).executionControl={paused:true};return result;};
 await automaticDelivery(f.options).scan();expect(f.run).not.toHaveBeenCalled();expect(f.options.report).not.toHaveBeenCalled();
 (f.board as any).executionControl={paused:false};f.options.view=view;await automaticDelivery(f.options).scan();expect(f.run).toHaveBeenCalledOnce();
});

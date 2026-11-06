import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {automaticDelivery} from '../src/kanban/automatic-delivery';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const item={id:'task',status:'review',planning:{kind:'task'}},board={id:'b',automation:{enabled:true},items:[item]},jobs=new Map<string,any>();
 const run=vi.fn(async(_board,request)=>{jobs.set(request.action,{id:request.action,runId:request.operationId,state:'succeeded',enabled:true});if(request.action==='accept')item.status='completed';return {revision:'revision',operations:[...jobs.values()]};});
 const view=vi.fn(async()=>({revision:'revision',operations:['build','deploy','accept','analyze','merge'].map(id=>jobs.get(id)??{id,enabled:true,state:'ready'})}));
 const options={service:{catalog:async()=>[{id:'b'}],read:async()=>board,workflow:async()=>({dispatches:{d:{id:'d',itemId:'task',attempt:1,outcome:'succeeded'}}})},journal,active:()=>true,automatic:async()=>true,view,run,cleanup:vi.fn(async()=>true),report:vi.fn()} as any;
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

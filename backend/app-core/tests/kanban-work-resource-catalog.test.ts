import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {boardWorkResources,registerWorkResource} from '../src/presets/kanban-work-resource-catalog';
const close:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});close.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const tasks=[{id:'child',number:2,title:'Execute',status:'completed',taskType:'execution',planning:{parentId:'group'},task:{phase:'completed'}},{id:'group',number:1,title:'Coordinate',status:'open',taskType:'coordination',planning:{execution:'children'},task:{phase:'running'},progress:{completed:1,total:2}}];
 const query=vi.fn(async(_board:string,filter:any)=>({revision:1,items:filter.ids?tasks.filter(task=>filter.ids.includes(task.id)):[],total:0}));
 const projectLabel=vi.fn(async()=> 'Project');
 const options={journal,service:{query} as any,projectLabel};
 return {journal,query,options,tasks};
}
it('lists indexed ownership and live group progress without inspecting Git or reading work logs',async()=>{
 const f=await fixture(),record={projectId:'project',context:{board:{id:'board'},task:{id:'child',createdAt:1,planning:{parentId:'group'}}}} as any;
 await f.journal.update('development-workspace:tree',()=>record);await f.journal.update('worktree:tree',()=>({directory:'/workspace/_nestos/worktrees/tree',branch:'work/tree'}));
 const find=vi.spyOn(f.journal,'find');
 const first=await boardWorkResources(f.options,'board');expect(first.items).toHaveLength(1);
 expect(first.items[0]).toMatchObject({id:'tree',itemId:'child',title:'work/tree',canCleanup:false,task:{status:'completed'},coordinationTask:{status:'open',progress:{completed:1,total:2}},project:{label:'Project'}});
 expect(f.query.mock.calls.at(-1)?.[1].ids).toEqual(['child','group']);
 find.mockClear();f.tasks[1].status='completed';const second=await boardWorkResources(f.options,'board');
 expect(second.items[0].coordinationTask?.status).toBe('completed');expect(find.mock.calls.some(call=>call[0]==='development-workspace:')).toBe(false);
 await f.journal.update('worktree-cleanup:tree',()=>({phase:'cleaned'}));expect((await boardWorkResources(f.options,'board')).total).toBe(0);
 expect((await boardWorkResources(f.options,'board',{includeCleaned:true})).items[0].state).toBe('cleaned');
});
it('paginates only the requested ownership rows and rejects invalid cursors or unauthorized boards',async()=>{
 const f=await fixture();await f.journal.update('work-resource-catalog-version',()=>1);
 for(const id of ['a','b'])await registerWorkResource(f.journal,id,{projectId:'project',context:{board:{id:'board'},task:{id:'child',createdAt:1,planning:{parentId:'group'}}}} as any);
 const page=await boardWorkResources(f.options,'board',{limit:1});expect(page.total).toBe(2);expect(page.items).toHaveLength(1);
 const next=await boardWorkResources(f.options,'board',{limit:1,cursor:page.nextCursor});expect(next.items[0].id).not.toBe(page.items[0].id);expect(next.nextCursor).toBeUndefined();
 await expect(boardWorkResources(f.options,'board',{cursor:'absent'})).rejects.toMatchObject({code:'CURSOR_STALE'});
 f.query.mockRejectedValueOnce(Object.assign(new Error('Denied'),{code:'EACCES'}));await expect(boardWorkResources(f.options,'other')).rejects.toMatchObject({code:'EACCES'});
});

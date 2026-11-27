import {expect,it,vi} from 'vitest';
import {projectClosedDevelopmentGroups,recordFollowUps} from '../src/kanban/record-follow-ups';
import type {KanbanItemSummary} from '@nestos/kanban/contracts';
const page={revision:1,total:1,items:[{id:'decision',kind:'decision',progress:{state:'completed',completion:'waived',lastActivityAt:1,groupIds:['group'],boardId:'execution'}}]} as any;
it('keeps accepted task facts while projecting pending decision cleanup in one batch',async()=>{
 const state={id:'cleanup',boardId:'execution',itemId:'group',step:5,requests:{}};
 const journal={getMany:vi.fn(async()=>[state]),diagnostic:vi.fn()};
 const result=await recordFollowUps(journal as any,'source',page);
 expect(result.items[0].progress).toMatchObject({state:'completed',completion:'waived',followUps:[{boardId:'execution',itemId:'group',phase:'cleanup',state:'pending'}]});
 expect(journal.getMany).toHaveBeenCalledExactlyOnceWith(['automatic-delivery:["execution","group"]']);
 expect(state.step).toBe(5);expect(page.items[0].progress.followUps).toBeUndefined();
});
it('clears a finished follow-up and never creates or runs a new task',async()=>{
 const journal={getMany:vi.fn(async()=>[{done:true,step:6,requests:{}}]),diagnostic:vi.fn()};
 expect((await recordFollowUps(journal as any,'source',page)).items[0].progress).toMatchObject({state:'completed',followUps:[]});
});
it('retains accepted tasks but marks unverified decision finalization checking with a classified cause',async()=>{
 const journal={getMany:vi.fn(async()=>{throw Object.assign(Error('PRIVATE_CONTENT'),{code:'EIO'});}),diagnostic:vi.fn()};
 expect((await recordFollowUps(journal as any,'source',page)).items[0].progress).toMatchObject({state:'checking',completion:'waived',followUps:[{state:'unknown',phase:'unknown',code:'EIO'}]});
 expect(journal.diagnostic).toHaveBeenCalledWith(expect.objectContaining({stage:'record.follow-ups.read',result:'failure',code:'EIO'}));expect(JSON.stringify(journal.diagnostic.mock.calls)).not.toContain('PRIVATE_CONTENT');
});

it('exposes explicit confirmation without executing or modifying its receipt',async()=>{
 const status={state:'waiting-confirmation',stage:'accept'};const journal={diagnostic:vi.fn()};const read=vi.fn(async()=>status);
 const result=await recordFollowUps(journal as any,'source',page,read as any);
 expect(result.items[0].progress).toMatchObject({state:'needs-action',stage:'finalization',reason:'confirmation-required',followUps:[{requiresConfirmation:true}]});
 expect(status).toEqual({state:'waiting-confirmation',stage:'accept'});expect(page.items[0].progress.state).toBe('completed');
});

it('preserves completed delivery with a visible dirty-worktree follow-up',async()=>{
 const journal={diagnostic:vi.fn()},read=vi.fn(async()=>({state:'blocked' as const,stage:'cleanup',code:'WORKTREE_DIRTY'}));
 const result=await recordFollowUps(journal as any,'source',page,read);
 expect(result.items[0].progress).toMatchObject({state:'completed',followUps:[{state:'blocked',phase:'cleanup',code:'WORKTREE_DIRTY'}]});
 expect(result.items[0].progress?.reason).toBeUndefined();
});

it('projects a failed merge while a completed set of execution tasks awaits settlement',async()=>{
 const waiting={...page,items:[{...page.items[0],progress:{...page.items[0].progress,state:'waiting',phase:'waiting-dependency',reason:'GROUP_SETTLEMENT_PENDING'}}]};
 const result=await recordFollowUps({diagnostic:vi.fn()} as any,'source',waiting,async()=>({state:'blocked',stage:'merge',code:'OPERATION_RESULT_AGENT_BLOCKED'}));
 expect(result.items[0].progress).toMatchObject({state:'needs-action',stage:'finalization',reason:'OPERATION_RESULT_AGENT_BLOCKED',followUps:[{phase:'merge',state:'blocked'}]});
});

it('projects repository target waiting and merge failure from one scoped journal read',async()=>{
 const rows=[
  {boardId:'b',itemId:'queued',scopeId:'repository-q',step:0,steps:['analyze','merge','accept'],waitingForTarget:true},
  {boardId:'b',itemId:'failure',scopeId:'repository-f',step:1,steps:['analyze','merge','accept'],code:'OPERATION_SELECTION_REQUIRED'},
  {boardId:'b',itemId:'done',scopeId:'repository-d',step:3,steps:['analyze','merge','accept','cleanup']},
 ];
 const journal={find:vi.fn(async(_prefix:string)=>rows.map(value=>({value}))),diagnostic:vi.fn()};
 const items=rows.map(row=>({id:row.itemId,externalRefs:[{system:'nestos-software-reports',id:'source'}]})) as KanbanItemSummary[];
 const result=await projectClosedDevelopmentGroups(journal as never,'b',items);
 expect(result.get('queued')).toEqual({phase:'waiting-dependency',reason:'DELIVERY_WAITING_FOR_TARGET'});
 expect(result.get('failure')).toEqual({phase:'error',reason:'OPERATION_SELECTION_REQUIRED'});
 expect(result.has('done')).toBe(false);
 expect(journal.find).toHaveBeenCalledTimes(1);
 expect(journal.find.mock.calls[0]?.[0]).toBe('automatic-delivery:["b",');
});

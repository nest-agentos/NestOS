import {expect,it,vi} from 'vitest';
import {recordFollowUps} from '../src/kanban/record-follow-ups';
const page={revision:1,total:1,items:[{id:'decision',kind:'decision',progress:{state:'completed',completion:'waived',lastActivityAt:1,groupIds:['group'],boardId:'execution'}}]} as any;
it('keeps accepted task facts while projecting pending decision cleanup in one batch',async()=>{
 const state={id:'cleanup',boardId:'execution',itemId:'group',step:5,requests:{}};
 const journal={getMany:vi.fn(async()=>[state]),diagnostic:vi.fn()};
 const result=await recordFollowUps(journal as any,'source',page);
 expect(result.items[0].progress).toMatchObject({state:'running',stage:'finalization',completion:'waived',followUps:[{boardId:'execution',itemId:'group',phase:'cleanup',state:'pending'}]});
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

import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal,jobKey,reviewCleanupKey} from '@nestos/kanban/integration';
import {beginManagementCleanup,completeManagementCleanup,readManagementCleanup,requestManagementCleanup} from '../src/kanban/cleanup-review-conversations';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const conversation={id:'manager',boardId:'b',sessionId:'native',resourceId:'/native/original',binding:{recordId:'decision',retainedPlanning:true,projectId:'p',profileId:'codex',directory:'/manager'}};
 await journal.update('record-conversation:analysis',()=>conversation);
 await journal.update('management-operation-scope:scope',()=>({id:'scope',ownerId:'root',boardId:'b',stage:'cleaned'}));
 await journal.update(jobKey('merge'),()=>({action:'merge',state:'succeeded',phase:'settled',boardId:'b',itemId:'root',scopeId:'scope',result:{targetHead:'integrated'},snapshot:{context:{management:{sources:[{itemId:'child',snapshot:{sourceVersion:'digest',context:{worktreeId:'work',directory:'/work',sourceHead:'old',repositories:[],secret:'excluded'}}}]}}}}));
 const rows=[{id:'work',state:'retained',ownership:'current',owner:{itemId:'child'},location:'/work',version:'v',canCleanup:false,reasons:['WORKTREE_DIRTY'],resolution:{kind:'ignored'}}];
 const view={pluginId:'software',revision:'revision',operations:[],scopes:[{id:'scope',view:{revision:'revision',operations:[{id:'accept',state:'succeeded'},{id:'merge',runId:'merge',state:'succeeded'}]}}]};
 const client={record:async()=>({itemIds:['root']}),read:async()=>({items:[{id:'root',planning:{execution:'children'}}]}),planningSession:async()=>({analysisId:'analysis',resourceId:'/native/original'}),workResources:vi.fn(async()=>rows),itemOperations:async()=>view,
  cleanupWorkResource:vi.fn(async()=>{rows[0].state='cleaned';return rows[0];}),runItemOperation:vi.fn(async()=>{await journal.update(reviewCleanupKey('b','root','scope'),(old:any)=>({...old,state:'succeeded'}));return view;})};
 const enqueue=vi.fn(async()=>{}),open=vi.fn(async()=>({enqueue,close:async()=>{}}));
 const options={journal,service:client,client:()=>client,remote:{projectConversation:open},log:vi.fn()} as any;
 const start=()=>beginManagementCleanup(options,conversation as any,{itemId:'root',scopeId:'scope',resourceIds:['work']},'request');
 return {journal,options,client,conversation,rows,enqueue,open,start};
}
it('reopens explicitly selected retained resources once in the same native Session',async()=>{
 const f=await fixture(),review=await f.start();await f.start();expect(f.enqueue).toHaveBeenCalledOnce();
 expect(f.open).toHaveBeenCalledWith('p','codex','native');
 expect(f.enqueue.mock.calls[0][0]).not.toContain('excluded');
 expect(await readManagementCleanup(f.options,f.conversation as any,review.reviewId)).toMatchObject({status:{state:'running',reviewState:'pending'}});
 expect(await f.journal.get('management-operation-scope:scope')).toMatchObject({stage:'accepted'});
});
it('rejects a foreign native Session and invalid resources before reopening cleanup',async()=>{
 const f=await fixture();f.conversation.sessionId='foreign';
 await expect(f.start()).rejects.toMatchObject({code:'CLEANUP_REVIEW_SESSION_CHANGED'});
 expect(await f.journal.get(reviewCleanupKey('b','root','scope'))).toBeUndefined();expect(f.enqueue).not.toHaveBeenCalled();
 f.conversation.sessionId='native';
 await expect(beginManagementCleanup(f.options,f.conversation as any,{itemId:'root',scopeId:'scope',resourceIds:['other']},'other')).rejects.toMatchObject({code:'CLEANUP_REVIEW_RESOURCE_INVALID'});
 expect(await f.journal.get('management-operation-scope:scope')).toMatchObject({stage:'cleaned'});
});
it('records remaining dirt only after the manager attempt and never trusts chat success',async()=>{
 const f=await fixture(),review=await f.start();
 expect(await completeManagementCleanup(f.options,f.conversation as any,review.reviewId)).toEqual({state:'blocked',residual:[{id:'work',code:'WORKTREE_DIRTY'}]});
 expect(f.client.cleanupWorkResource).not.toHaveBeenCalled();expect(f.client.runItemOperation).not.toHaveBeenCalled();
 expect(await f.journal.get(reviewCleanupKey('b','root','scope'))).toMatchObject({state:'failed',reviewState:'reviewed',code:'WORKTREE_DIRTY'});
});
it('physically removes verified clean resources using fresh versions and then finalizes the host receipt',async()=>{
 const f=await fixture(),review=await f.start();f.rows[0].reasons=[];f.rows[0].version='fresh';
 expect(await completeManagementCleanup(f.options,f.conversation as any,review.reviewId)).toMatchObject({state:'completed',resources:['work']});
 expect(f.client.cleanupWorkResource).toHaveBeenCalledWith('b',expect.objectContaining({itemId:'child',resourceId:'work',version:'fresh'}));
 await completeManagementCleanup(f.options,f.conversation as any,review.reviewId);expect(f.client.cleanupWorkResource).toHaveBeenCalledOnce();
});
it('uses the same queue identity after a lost acknowledgement and respects ignored resources in automatic review',async()=>{
 const f=await fixture();f.enqueue.mockRejectedValueOnce(Object.assign(Error('lost'),{code:'EIO'}));
 await expect(f.start()).rejects.toMatchObject({code:'EIO'});await f.start();
 expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
 const current=await f.journal.get<any>(reviewCleanupKey('b','root','scope'));
 const automatic=await requestManagementCleanup(f.options,{...current,boardId:'b',itemId:'root',scopeId:'scope',operationId:'automatic'});
 expect(automatic.resources).toEqual([]);
});

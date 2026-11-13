import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {managementTaskOwner as managementOwner} from '@nestos/kanban/integration';
import {managementScopes,freezeManagementScope,integratedContributionKey} from '../src/presets/kanban-management-scope-catalog';
import {managementBatchSnapshot} from '../src/presets/kanban-management-snapshot';
import {verifyManagementMerge} from '../src/presets/kanban-management-review';
import {verifyManagementChanges} from '@nestos/git-delivery/integration';
const mock=vi.hoisted(()=>({git:vi.fn()}));
vi.mock('../src/presets/kanban-development-workspace',()=>({developmentWorkspace:async(_r,_p,_id,work)=>work({})}));
vi.mock('@nestos/git-delivery/repositories',()=>({gitWorkspace:(...args)=>mock.git(...args)}));
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();mock.git.mockReset();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const owner={id:'manager',title:'Manage',planning:{execution:'children'}},items=[owner,...['a','b','c'].map((id,i)=>({id,title:id,status:'completed',planning:{parentId:'manager'},externalRefs:[{system:'nestos-remote-project',id:i<2?'repo-one':'repo-two'}]}))];
 const board={id:'board',items},dispatches=Object.fromEntries(items.slice(1).map(item=>[item.id,{id:item.id+'-dispatch',itemId:item.id,attempt:1,outcome:'accepted'}]));
 const service={workflow:async()=>({dispatches}),item:async(_board,id)=>({item:items.find(row=>row.id===id)})};
 const options={journal,service,projectLabel:async(id)=>id};
 const scopes=await managementScopes(options as never,board as never,owner as never);
 const snapshot=vi.fn(async(item)=>({version:item.id,sourceVersion:item.id,targetVersion:'target',context:{sourceHead:item.id,directory:'/source/'+item.id,repositories:[{path:'.',dirty:false}]}}));
 return {options,board,owner,items,dispatches,scopes,snapshot,journal,service};
}
it('groups execution contributions by repository under the actual management owner without creating state on reads',async()=>{
 const f=await fixture();expect(f.scopes.map(scope=>scope.contributors.map(item=>item.itemId))).toEqual([['a','b'],['c']]);
 expect(await f.journal.get('management-operation-scopes:'+JSON.stringify(['board','manager']))).toBeUndefined();
 expect(managementOwner(f.board as never,f.items[1] as never)?.id).toBe('manager');
 const bad={...f.owner,planning:{execution:'children',parentId:'a'}};expect(()=>managementOwner({...f.board,items:[bad,...f.items.slice(1)]} as never,bad as never)).toThrowError(expect.objectContaining({code:'OPERATION_OWNER_INVALID'}));
});
it('retains a verified repository receipt and includes a new execution attempt in a new scope',async()=>{
 const f=await fixture(),scope=f.scopes[0];await freezeManagementScope(f.journal,scope);
 for(const source of scope.contributors)await f.journal.update(integratedContributionKey('board','manager',source.dispatchId!),()=>({scopeId:scope.id}));
 f.dispatches.a={...f.dispatches.a,id:'a-retry',attempt:2};
 const next=await managementScopes(f.options as never,f.board as never,f.owner as never);
 expect(next.find(row=>row.id!==scope.id&&row.projectId==='repo-one')?.contributors.map(row=>row.dispatchId)).toEqual(['a-retry']);
 expect(next.some(row=>row.id===scope.id)).toBe(true);
});
it('freezes all source versions and refuses changed attempts, ownership or inconsistent targets',async()=>{
 const f=await fixture(),scope=f.scopes[0];const snapshot=await managementBatchSnapshot(scope,f.board as never,f.service as never,f.snapshot);
 expect((snapshot.context as any).management.sources).toHaveLength(2);
 f.snapshot.mockImplementation(async(item)=>({version:item.id,sourceVersion:item.id,targetVersion:item.id,context:{sourceHead:item.id,directory:'/source/'+item.id,repositories:[{path:'.',dirty:false}]}}));
 await expect(managementBatchSnapshot(scope,f.board as never,f.service as never,f.snapshot)).rejects.toMatchObject({code:'OPERATION_TARGET_CHANGED'});
 f.dispatches.a={...f.dispatches.a,id:'retry',attempt:2};
 await expect(managementBatchSnapshot(scope,f.board as never,f.service as never,f.snapshot)).rejects.toMatchObject({code:'OPERATION_SOURCES_NOT_READY'});
});
it('checks every source commit and refuses a partial batch even when the retained Session reports success',async()=>{
 const f=await fixture(),snapshot=await managementBatchSnapshot(f.scopes[0],f.board as never,f.service as never,f.snapshot),job={snapshot,operationContext:{}};
 mock.git.mockImplementation(async(_p,_cwd,args)=>({code:args[2]==='b'?1:0,stdout:''}));
 await expect(verifyManagementMerge({} as never,job as never,{targetVersion:'merged'} as never,{targetHead:'merged'})).rejects.toMatchObject({code:'OPERATION_RESULT_BATCH_INCOMPLETE'});
 expect(mock.git.mock.calls.some(call=>call[2][2]==='b')).toBe(true);
 mock.git.mockResolvedValue({code:0,stdout:''});await expect(verifyManagementMerge({} as never,job as never,{targetVersion:'merged'} as never,{targetHead:'merged'})).resolves.toBeUndefined();
 await expect(verifyManagementMerge({} as never,job as never,{targetVersion:'changed'} as never,{targetHead:'merged'})).rejects.toMatchObject({code:'OPERATION_RESULT_MERGE_UNCONFIRMED'});
});
it('validates the target gitlink rather than accepting the users currently checked out submodule HEAD',async()=>{
 const f=await fixture(),snapshot=await managementBatchSnapshot(f.scopes[0],f.board as never,f.service as never,f.snapshot);
 (snapshot.context as any).management.sources[1].snapshot.context.repositories.push({path:'module',head:'module-source'});
 const locked='a'.repeat(40);mock.git.mockImplementation(async(_p,cwd,args)=>({code:cwd==='/workspace/module'?1:0,stdout:args[0]==='ls-tree'?'160000 commit '+locked+'\tmodule\n':''}));
 await expect(verifyManagementMerge({} as never,{snapshot} as never,{targetVersion:'merged'} as never,{targetHead:'merged'})).rejects.toMatchObject({code:'OPERATION_RESULT_BATCH_INCOMPLETE'});
 expect(mock.git.mock.calls.find(call=>call[1]==='/workspace/module')?.[2]).toEqual(['merge-base','--is-ancestor','module-source',locked]);
});
it('keeps changes-only policy and verifies target file effects unless the user approved that exact conflict',async()=>{
 mock.git.mockImplementation(async(_p,_cwd,args)=>({code:0,stdout:args[0]==='diff'?(args.includes('--diff-filter=D')?'':'file.ts\0'):args[0]==='ls-tree'?'100644 blob target-hash\tfile.ts\n':args[0]==='hash-object'?'source-hash\n':''}));
 await expect(verifyManagementChanges({} as never,{} as never,'/source','target','.')).rejects.toMatchObject({code:'OPERATION_RESULT_BATCH_INCOMPLETE'});
 const approved={operationContext:{selections:{file:'combine'},plan:{conflicts:[{id:'file',path:'file.ts',options:[{id:'combine'}]}]}}};
 await expect(verifyManagementChanges({} as never,approved.operationContext,'/source','target','.')).resolves.toBeUndefined();
 expect(mock.git.mock.calls.every(call=>!['commit','reset','stash','merge'].includes(call[2][0]))).toBe(true);
});

it('coalesces project aliases bound to the same authorized repository root',async()=>{
 const f=await fixture(),scopes=await managementScopes({...f.options,repositoryKey:()=> 'server/repository'} as never,f.board as never,f.owner as never);
 expect(scopes).toHaveLength(1);expect(scopes[0].contributors.map(item=>item.itemId)).toEqual(['a','b','c']);
});

it('resolves archived parent identities through the item API instead of the visible board',async()=>{
 const {managementOwner:resolve}=await import('../src/kanban/task-owner');
 const parent={id:'archived-manager',status:'completed',planning:{execution:'children'}},child={id:'archived-child',planning:{parentId:parent.id}},item=vi.fn(async()=>({item:parent,archive:{archivedAt:1}}));
 expect(await resolve({item} as never,{id:'board',items:[]} as never,child as never)).toBe(parent);
 expect(item).toHaveBeenCalledWith('board',parent.id);
});

it('retains deleted parent identity for cancelled task history',async()=>{
 const {managementOwner:resolve}=await import('../src/kanban/task-owner');
 const parent={id:'deleted-manager',deletedAt:1,planning:{execution:'children'}},child={id:'cancelled-child',status:'cancelled',planning:{parentId:parent.id}};
 expect(await resolve({item:async()=>({item:parent})} as never,{id:'board',items:[child]} as never,child as never)).toBe(parent);
});

import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {recordCoordination} from '../src/kanban/record-coordination';
import {resolveCoordinationRequest} from '../src/kanban/coordination-conversation-requests';
const closes:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
 const actor={kind:'human' as const,id:'owner'},service=createKanbanModule({store:await SeqKanbanStore.open(fs),actor,authorize:async()=>{},log(){}});
 await service.create({id:'b',title:'Board',scope:{kind:'system'},policy:{requireEstimate:false},members:[{...actor,responsibility:'Work',roles:['coordinator','worker','reviewer']}]});
 let serial=0;const command=async(command:any)=>service.execute('b',{operationId:'seed-'+ ++serial,expectedRevision:(await service.read('b')).revision,command});
 await command({type:'create-item',item:{id:'group',title:'Coordination',purpose:'planning',responsibility:'Plan',acceptance:'Checked'},planning:{kind:'coordination',priority:2,dependencies:[],references:[]}});
 await command({type:'link-reference',itemId:'group',reference:{system:'nestos-remote-project',id:'project'}});
 for(const id of ['decision','other']){await command({type:'append-record',record:{id,kind:'decision',title:id,content:'Scope',rationale:'Checked',itemIds:id==='decision'?['group']:[],sources:[],externalRefs:[{system:'nestos-remote-project',id:'project'}]}});await command({type:'review-record',recordId:id,accept:true});}
 const read=vi.fn(async()=>({messages:[{id:'u1',role:'user',text:'Not confirmed'}]}));
 const options={fs,journal,service,client:()=>service,remote:{projectConversation:async()=>({read,close:async()=>{}})},log:vi.fn()} as any;
 const conversation={id:'persistent',boardId:'b',sessionId:'native',resourceId:'/native/original',binding:{id:'persistent',purpose:'coordination',recordId:'decision',projectId:'project',profileId:'codex'}} as any;
 const request=(method:string,params:any={},id=method)=>resolveCoordinationRequest(options,conversation,{id,scopeId:conversation.id,method,params});
 return {journal,service,options,conversation,command,read,request};
}
it('creates one retained communication identity without a planning admission or a worktree',async()=>{
 const f=await fixture(),start=vi.fn(async(_board:string,request:any)=>{const row={id:request.operationId,boardId:'b',createdAt:1,sessionId:'native',resourceId:'/native/original',state:'confirmed'};await f.journal.update('record-conversation:'+row.id,()=>row);return row;});
 const open=recordCoordination(f.options,{startRecordConversation:start} as any);
 const first=await open('b',{recordId:'decision',operationId:'open-1'});
 expect(first).toMatchObject({purpose:'coordination',recordId:'decision',resourceId:'/native/original'});
 expect(await f.journal.get('record-coordination-scope:'+first.id)).toEqual({recordId:'decision'});
 const reopened=recordCoordination(f.options,{startRecordConversation:start} as any);
 expect(await reopened('b',{recordId:'decision',operationId:'open-2'})).toMatchObject({id:first.id,sessionId:'native'});
 expect(start).toHaveBeenCalledOnce();
});
it('reads concrete pre-session preparation failures and requests a fenced retry of the original group',async()=>{
 const f=await fixture();await f.command({type:'report-analysis',itemId:'group',operationId:'failed',status:{itemId:'group',state:'failed',code:'GIT_WORKTREE_CREATE_FAILED'}});
 const state=await f.request('coordination.read');expect(state).toMatchObject({groups:[{id:'group',retryPlanning:true}],tasks:[{analysis:{code:'GIT_WORKTREE_CREATE_FAILED'}}]});
 const group=(await f.service.item('b','group')).item;
 expect(await f.request('coordination.retry-planning',{itemId:'group',revision:group.revision})).toEqual({itemId:'group',state:'retry-requested'});
 expect((await f.service.item('b','group')).item.analysis).toBeUndefined();
 expect(await f.request('coordination.retry-planning',{itemId:'group',revision:group.revision})).toEqual({itemId:'group',state:'retry-requested'});
 await expect(f.request('coordination.retry-planning',{itemId:'group',revision:group.revision},'stale')).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 f.conversation.binding.recordId='other';await expect(f.request('coordination.retry-planning',{itemId:'group',revision:group.revision},'foreign')).rejects.toMatchObject({code:'ITEM_NOT_IN_DECISION'});
});
it('confirms a scoped follow-up after all original tasks completed without changing their evidence',async()=>{
 const f=await fixture();
 // Configure the same board automation contract consumed by ordinary coordination fixes.
 const target={system:'nestos-target',id:'target',revision:'v1'};
 await f.command({type:'configure-automation',settings:{enabled:true,autoAccept:true,planner:target,executor:target,coordinator:{kind:'human',id:'owner'},worker:{kind:'human',id:'owner'}}});
 await f.command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'original-plan',revision:1,sealed:true,rootItemId:'group',coordination:true,items:[{id:'original-child',title:'Original',workType:'task',responsibility:'Build',acceptance:'Checked',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
 await f.command({type:'prepare-dispatch',itemId:'original-child',dispatchId:'original-attempt'});
 await f.command({type:'observe-execution',dispatchId:'original-attempt',fence:(await f.service.workflow('b')).dispatches['original-attempt'].fence,outcome:'succeeded',outputs:[]});
 await f.command({type:'close-plan',itemId:'group',resultRef:'original-plan'});
 const completed=await f.service.item('b','original-child');expect(completed.item.status).toBe('completed');
 await f.journal.update('worktree:original-attempt',()=>({state:'cleaned'}));
 const board=await f.service.read('b');
 const proposal={schema:'kanban.coordination-proposal/1',type:'append',tasks:[{key:'fix',title:'Repair',responsibility:'Repair source',acceptance:'Checked',dependsOn:[]}]};
 const saved=await f.request('coordination.propose-fix',{itemId:'group',proposal}) as any;
 expect((await f.service.read('b')).items).toHaveLength(board.items.length);
 const params={proposalId:saved.proposalId,proposalDigest:saved.proposalDigest};
 await expect(f.request('coordination.confirm-fix',params)).rejects.toMatchObject({code:'FIX_USER_CONFIRMATION_REQUIRED'});
 f.read.mockResolvedValue({messages:[{id:'u2',role:'user',text:'确认修复'}]});
 expect(await f.request('coordination.confirm-fix',params)).toMatchObject({state:'accepted'});
 await f.request('coordination.confirm-fix',params);
 const children=(await f.service.read('b')).items.filter(item=>item.planning?.parentId==='group');
 expect(children).toHaveLength(2);expect(await f.service.item('b','original-child')).toEqual(completed);expect(children.find(item=>item.id!=='original-child')!.externalRefs).toContainEqual({system:'nestos-remote-project',id:'project'});
 f.conversation.id='foreign';await expect(f.request('coordination.confirm-fix',params,'foreign-confirm')).rejects.toMatchObject({code:'ITEM_NOT_IN_DECISION'});
});

it('keeps the native coordination Session usable after worktree cleanup and recovers an uncertain create receipt',async()=>{
 const {decisionConversations}=await import('../src/kanban/decision-conversations');
 const f=await fixture();let failCreate=true;
 const create=vi.fn(async(..._args:any[])=>{if(failCreate){failCreate=false;throw Object.assign(Error('Lost reply'),{code:'HTTP_CONNECTION_LOST'});}return {session:{id:'native-persistent'}};});
 const operation=vi.fn(async()=>({outcome:'committed',result:{session:{id:'native-persistent'}}}));
 const enqueue=vi.fn(async()=>{}),close=async()=>{},stop=vi.fn();
 const mount={at:'/',serverId:'cell',serverProjectId:'cell-project',serverProjectRevision:1,connectionId:'node',authorization:{principalId:'owner',revision:'auth'}};
 f.options.projects={get:async()=>({path:'/project',project:{id:'project',source:{kind:'remote'}}}),openWorkspace:async()=>({fs:f.options.fs,dispose:async()=>{}})};
 f.options.remote={list:()=>[mount],projectHarness:async()=>({profiles:async()=>({epoch:'epoch',profiles:[{id:'codex',projectRuntime:true,capabilities:{create:true,sessionChannels:true,workingDirectory:true},workspaces:[{id:'cell-project'}]}]}),create,operation,close,subscribeChannel:()=>stop}),projectConversation:async()=>({enqueue,read:f.read,close}),sessionChannel:async(_p:string,method:string,args:any)=>method==='open'?{projectContext:{projects:args.contextProjects.map((row:any)=>({...row,directory:'/real/project'}))}}:method==='requests'?{requests:[]}:method==='messages'?{messages:[]}:{}};
 const conversations=decisionConversations(f.options);closes.push(()=>conversations.quiesce());
 await expect(conversations.openRecordCoordination('b',{recordId:'decision',operationId:'first'})).rejects.toMatchObject({code:'HTTP_CONNECTION_LOST'});
 const recovered=await conversations.openRecordCoordination('b',{recordId:'decision',operationId:'second'});
 expect(recovered).toMatchObject({sessionId:'native-persistent',purpose:'coordination'});expect(create).toHaveBeenCalledOnce();expect(operation).toHaveBeenCalledOnce();
 await f.journal.update('worktree:old',()=>({state:'cleaned'}));
 const reopened=await conversations.openRecordCoordination('b',{recordId:'decision',operationId:'third'});
 expect(reopened.sessionId).toBe(recovered.sessionId);expect(enqueue).toHaveBeenCalledOnce();
 expect((await conversations.recordConversations('b')).find(row=>row.id===recovered.id)).toMatchObject({purpose:'coordination',recordId:'decision'});
 expect(create.mock.calls[0][2]).toMatchObject({directory:'_nestos/kanban/conversations/'+recovered.id});
});

it('routes a recoverable execution blocker to its executor and a settled failure to coordination',async()=>{
 const {taskCommunication}=await import('../src/kanban/task-communication');
 const f=await fixture();await f.command({type:'link-reference',itemId:'group',reference:{system:'nestos-decision-run',id:'run'}});
 const record=await f.service.record('b','decision');await f.journal.update('record-context:run',()=>({sourceBoardId:'b',recordId:'decision',recordRevision:record.revision,runId:'run'}));
 await f.command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,rootItemId:'group',items:[{id:'child',title:'Execution',responsibility:'Build',acceptance:'Checked',assignee:{kind:'human',id:'owner'},dependsOn:[],externalRefs:[{system:'nestos-remote-project',id:'project'},{system:'nestos-decision-run',id:'run'}]}]}});
 await f.command({type:'prepare-dispatch',itemId:'child',dispatchId:'attempt'});
 await f.command({type:'link-reference',itemId:'child',reference:{system:'nestos-execution-session',id:'executor',revision:'attempt'}});
 await f.command({type:'observe-execution',dispatchId:'attempt',fence:(await f.service.workflow('b')).dispatches.attempt.fence,outcome:'running',executionSessionId:'executor'});
 await f.command({type:'report-issue',itemId:'child',issue:{id:'error',attemptId:'attempt',type:'error',handler:'self'}});
 const open=vi.fn(async()=>({id:'persistent',boardId:'b',recordId:'decision',resourceId:'/native/coordinate',state:'confirmed' as const,createdAt:1}));
 const communication=taskCommunication(f.service,f.journal,{...f.options,executionResource:async(id:string)=>'/native/'+id} as any,open);
 expect(await communication.openTaskCommunication('b',{itemId:'child',operationId:'open-running'})).toMatchObject({resourceId:'/native/executor'});expect(open).not.toHaveBeenCalled();
 await f.command({type:'report-issue',itemId:'child',issue:{id:'parent-error',attemptId:'attempt',type:'error',handler:'parent'}});
 expect(await communication.openTaskCommunication('b',{itemId:'child',operationId:'open-parent'})).toMatchObject({resourceId:'/native/coordinate'});
 await f.command({type:'resolve-issue',itemId:'child',issueId:'parent-error',attemptId:'attempt',resolvedBy:'fixed'});
 const page=await f.service.records('b',{kind:'decision'});expect(page.items.find(row=>row.id==='decision')?.attentionTasks).toContainEqual(expect.objectContaining({itemId:'child',title:'Execution',purpose:'execution'}));
 await f.command({type:'observe-execution',dispatchId:'attempt',fence:(await f.service.workflow('b')).dispatches.attempt.fence,outcome:'failed'});
 expect(await communication.openTaskCommunication('b',{itemId:'child',operationId:'open-failed'})).toMatchObject({resourceId:'/native/coordinate'});
 expect(open).toHaveBeenCalledWith('b',{recordId:'decision',operationId:'open-failed'});
});

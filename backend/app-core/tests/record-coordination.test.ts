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
it('resolves the original management Session and never creates a separate coordination Session',async()=>{
 const f=await fixture(),planningSession=vi.fn(async()=>({analysisId:'planning',sessionId:'native',resourceId:'/native/original',state:'completed'}));
 f.options.client=()=>({...f.service,planningSession});const open=recordCoordination(f.options);
 expect(await open('b',{recordId:'decision',operationId:'open-1'})).toMatchObject({id:'planning',sessionId:'native',resourceId:'/native/original'});
 expect(await open('b',{recordId:'decision',operationId:'open-2'})).toMatchObject({id:'planning',sessionId:'native'});
 expect(await f.journal.get('record-coordination:'+JSON.stringify(['b','decision']))).toBeUndefined();
 planningSession.mockResolvedValueOnce(undefined as any);
 await expect(open('b',{recordId:'decision',operationId:'not-ready'})).rejects.toMatchObject({code:'MANAGEMENT_SESSION_NOT_READY'});
 await expect(open('b',{recordId:'other',operationId:'no-task'})).rejects.toMatchObject({code:'MANAGEMENT_SESSION_NOT_READY'});
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


it('routes management communication to its admitted session without starting another record conversation',async()=>{
 const {taskCommunication}=await import('../src/kanban/task-communication');const f=await fixture();
 await f.command({type:'link-reference',itemId:'group',reference:{system:'nestos-decision-run',id:'run'}});
 const record=await f.service.record('b','decision');await f.journal.update('record-context:run',()=>({sourceBoardId:'b',recordId:'decision',recordRevision:record.revision,runId:'run'}));
 await f.journal.update('analysis-current:'+JSON.stringify(['b','group']),()=> 'original-analysis');
 await f.journal.update('original-analysis',()=>({id:'analysis',input:{request:{}},status:{state:'analyzing'}}));
 const open=vi.fn(),calls={inspectTaskCallSubmission:vi.fn(async()=>({executionSessionId:'management'}))};
 const api=taskCommunication(f.service,f.journal,{...f.options,calls,executionResource:async()=>'/native/management'} as any,open);
 expect(await api.openTaskCoordination('b',{itemId:'group',operationId:'open'})).toMatchObject({id:'analysis',sessionId:'management',resourceId:'/native/management'});
 expect(open).not.toHaveBeenCalled();
});

it('routes delivery analysis through the current client, repository scope and durable request identity',async()=>{
 const f=await fixture(),view={pluginId:'software',revision:'outer',operations:[],scopes:[{id:'repo',label:'Repository',contributors:[],view:{revision:'v1',operations:[{id:'analyze',label:'Submit',state:'failed',enabled:true}]}}]};
 const read=vi.fn(async()=>view),run=vi.fn().mockRejectedValueOnce(Object.assign(Error('lost'),{code:'HTTP_CONNECTION_LOST',outcome:'unknown'})).mockResolvedValue(view);
 f.options.client=()=>({...f.service,itemOperations:read,runItemOperation:run});
 expect(await f.request('coordination.read')).toMatchObject({capabilities:{discover:'kanban.discover'}});
 expect(await f.request('coordination.operations.read',{itemId:'group'})).toBe(view);
 const params={itemId:'group',request:{pluginId:'software',scopeId:'repo',action:'analyze',expectedRevision:'v1'}};
 await expect(f.request('coordination.operations.run',params,'analysis')).rejects.toMatchObject({code:'HTTP_CONNECTION_LOST'});
 view.scopes[0].view.revision='v2';await f.request('coordination.operations.run',params,'analysis');
 expect(run.mock.calls[0]).toEqual(run.mock.calls[1]);expect(read).toHaveBeenCalledTimes(2);
 expect(run.mock.calls[0]).toEqual(['b',expect.objectContaining({itemId:'group',scopeId:'repo',action:'analyze',expectedRevision:'v1',operationId:expect.stringMatching(/^coordinate-operation-/)})]);
 await expect(f.request('coordination.operations.run',{...params,request:{...params.request,action:'merge'}},'analysis')).rejects.toMatchObject({code:'CHANNEL_REQUEST_CHANGED'});
 expect(f.options.log).toHaveBeenCalledWith(expect.objectContaining({stage:'coordination.operations.run',result:'failure',code:'HTTP_CONNECTION_LOST'}));
 expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('expectedRevision');
});
it('keeps delivery requests inside the bound management task and honors actual human confirmation',async()=>{
 const f=await fixture(),view={revision:'v1',operations:[{id:'merge',label:'Merge',state:'ready',enabled:true,confirmation:'Confirm merge'}]};
 const run=vi.fn(async()=>view);f.options.client=()=>({...f.service,itemOperations:async()=>view,runItemOperation:run});
 const params={itemId:'group',request:{action:'merge',expectedRevision:'v1'}};
 await expect(f.request('coordination.operations.run',params,'merge')).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});expect(run).not.toHaveBeenCalled();
 await expect(f.request('coordination.operations.run',{...params,request:{...params.request,confirmed:true}},'fake')).rejects.toMatchObject({code:'OPERATION_REQUEST_INVALID'});
 f.read.mockResolvedValue({messages:[{id:'confirmed-merge',role:'user',text:'Confirm merge'}]});await f.request('coordination.operations.run',params,'merge');
 expect(run).toHaveBeenCalledWith('b',expect.objectContaining({confirmed:true,itemId:'group'}));
 f.conversation.binding.recordId='other';await expect(f.request('coordination.operations.read',{itemId:'group'})).rejects.toMatchObject({code:'ITEM_NOT_IN_DECISION'});
});
it('rejects stale revisions and reconciles an unknown delivery without starting another mutation',async()=>{
 const f=await fixture(),view={revision:'latest',operations:[{id:'analyze',label:'Analyze',state:'unknown',enabled:false,runId:'original'}]};
 const run=vi.fn(async()=>view);f.options.client=()=>({...f.service,itemOperations:async()=>view,runItemOperation:run});
 const params={itemId:'group',request:{action:'analyze',expectedRevision:'old'}};
 await expect(f.request('coordination.operations.run',params)).rejects.toMatchObject({code:'OPERATION_STALE_REFRESH'});
 params.request.expectedRevision='latest';await expect(f.request('coordination.operations.run',params)).rejects.toMatchObject({code:'OPERATION_PREREQUISITE_REQUIRED'});
 await f.request('coordination.operations.run',{...params,request:{...params.request,reconcile:{runId:'original'}}},'reconcile');
 expect(run).toHaveBeenCalledExactlyOnceWith('b',expect.objectContaining({reconcile:{runId:'original'}}));
});
it('adopts the existing settled planning channel without creating or moving a native Session',async()=>{
 const f=await fixture(),{adoptPlanningConversation}=await import('../src/kanban/adopt-planning-conversation');
 await f.journal.update('analysis-current:'+JSON.stringify(['b','group']),()=> 'analysis:original');
 await f.journal.update('analysis:original',()=>({id:'original',phase:'settled'}));
 await f.journal.update('development-workspace:original',()=>({projectId:'project',directory:'/workspace/original',context:{decision:{sourceBoardId:'b',recordId:'decision'}}}));
 await f.journal.update('kanban-harness-choice:original',()=>({profileId:'codex'}));
 const create=vi.fn(),close=vi.fn(async()=>{});f.options.remote={...f.options.remote,sessionChannel:vi.fn(async(_project:string,operation:string)=>operation==='requests'?{requests:[]}:{scopeId:'coordinate-current',execution:{sessionId:'native'}}),projectHarness:async()=>({create,profiles:async()=>({epoch:'current'}),close}),list:()=>[{at:'/',serverProjectId:'workspace'}]};
 const start=vi.fn(async()=>{}),adopt=adoptPlanningConversation(f.options,start),value={analysisId:'original',resourceId:'/folder:project/@harness/codex/native'} as any;
 await adopt('b','group',value);await adopt('b','group',value);
 expect(await f.journal.get('record-conversation:original')).toMatchObject({sessionId:'native',resourceId:value.resourceId,binding:{id:'original',channelId:'coordinate-current',purpose:'coordination',recordId:'decision',directory:'/workspace/original'}});
 expect(create).not.toHaveBeenCalled();expect(start).toHaveBeenCalledOnce();expect(f.options.remote.sessionChannel).toHaveBeenCalledTimes(3);
});

it('answers the current phase channel while retaining the logical management and native Session identities',async()=>{
 const f=await fixture(),{decisionConversations}=await import('../src/kanban/decision-conversations'),{channelDigest}=await import('../src/run/channel-protocol');
 const request={id:'discover-current',scopeId:'coordinate-new',method:'kanban.discover',params:{}};
 const enqueue=vi.fn(async()=>{}),stop=vi.fn(),subscribeChannel=vi.fn(()=>stop);
 const sessionChannel=vi.fn(async(_project:string,method:string,args:any):Promise<any>=>{
  if(method==='current')return {scopeId:'coordinate-new',execution:{sessionId:'native'}};
  if(method==='messages')return {messages:[]};
  if(method==='requests')return {requests:[{request,requestDigest:channelDigest(request),response:null}]};
  if(method==='respond')return args;
  throw Error(method);
 });
 f.options.remote={...f.options.remote,sessionChannel,projectHarness:async()=>({subscribeChannel,close:async()=>{}}),projectConversation:async()=>({enqueue,read:f.read,subscribe:()=>()=>{},snapshot:()=>({active:false,pending:false}),close:async()=>{}})};
 await f.journal.update('record-conversation:persistent',()=>({...f.conversation,state:'confirmed',createdAt:1,binding:{...f.conversation.binding,directory:'/original',retainedPlanning:true,channelId:'planning-old'}}));
 const conversations=decisionConversations(f.options);closes.push(()=>conversations.quiesce());
 await conversations.startRecordConversation('b',{operationId:'persistent'});
 expect(sessionChannel.mock.calls.filter(call=>call[1]==='respond')).toEqual([['project','respond',expect.objectContaining({id:request.id,scopeId:'coordinate-new',status:'ok'})]]);
 expect(enqueue).toHaveBeenCalledOnce();
 expect(await f.journal.get('decision-response:coordinate-new:discover-current:resumed')).toBe(true);
 expect(await f.journal.get('record-conversation:persistent')).toMatchObject({id:'persistent',sessionId:'native',binding:{channelId:'coordinate-new'}});
 await conversations.scan();await vi.waitFor(()=>expect(subscribeChannel).toHaveBeenLastCalledWith('coordinate-new',expect.any(Function)));
 expect(stop).toHaveBeenCalledOnce();expect(enqueue).toHaveBeenCalledOnce();
});

it('ignores cancelled and archived historical management runs when resolving the current Session',async()=>{
 const f=await fixture();await f.command({type:'create-item',item:{id:'historical',taskType:'coordination',title:'Previous',responsibility:'Previous',acceptance:'Checked'}});
 await f.command({type:'link-record',recordId:'decision',itemId:'historical'});
 const planningSession=vi.fn(async()=>({analysisId:'current',sessionId:'native',resourceId:'/native/current',state:'completed'}));
 const client={...f.service,item:async(board:string,id:string)=>{const value=await f.service.item(board,id);return id==='historical'?{...value,archive:{at:1},item:{...value.item,status:'cancelled'}}:value;},planningSession,
  recordExecutions:async()=>[{id:'old',boardId:'b',rootItemId:'historical',state:'cancelled',archivedAt:1},{id:'new',boardId:'b',rootItemId:'group',state:'running'}]};
 f.options.client=()=>client;
 expect(await recordCoordination(f.options)('b',{recordId:'decision',operationId:'resolve'})).toMatchObject({sessionId:'native'});
 expect(planningSession).toHaveBeenCalledExactlyOnceWith('b','group');
});

it('repairs only the original retained Session directory after proven legacy worktree cleanup',async()=>{
 const f=await fixture(),{retainManagementDirectory}=await import('../src/kanban/retained-management-directory');
 const value={...f.conversation,id:'original',binding:{...f.conversation.binding,retainedPlanning:true,directory:'/workspace/_nestos/worktrees/original',channelId:'current'}};
 f.options.projects={get:async()=>({path:'/project'}),openWorkspace:async()=>({fs:f.options.fs,dispose:async()=>{}})};
 expect(await retainManagementDirectory(f.options,value)).toBe(false);
 expect(await f.options.fs.driver.exists(value.binding.directory)).toBe(false);
 await f.journal.update('worktree-cleanup:original',()=>({phase:'cleaned'}));
 expect(await retainManagementDirectory(f.options,value)).toBe(true);
 expect(await retainManagementDirectory(f.options,value)).toBe(false);
 expect(value.sessionId).toBe('native');expect(await f.options.fs.driver.exists(value.binding.directory+'/.nestos-management-context')).toBe(true);
 await expect(retainManagementDirectory(f.options,{...value,binding:{...value.binding,directory:'/unrelated'}})).rejects.toMatchObject({code:'MANAGEMENT_DIRECTORY_BINDING_CHANGED'});
});

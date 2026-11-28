import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {resolveDecisionRequest} from '../src/kanban/decision-conversation-requests';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs),journal=new KanbanAutomationJournal(fs);await journal.open();
 const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){}});await service.create({id:'b',title:'Board',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['coordinator','reviewer','worker']}]});
 const read=vi.fn(async()=>({messages:[{id:'user-1',role:'user',text:'Not confirmed'}]})),runRecord=vi.fn(async()=>({state:'running'})),fixTask=vi.fn(async()=>({sessionId:'original-group-session'}));
 const options={fs,service,journal,client:()=>({...service,runRecord,fixTask}),projects:{get:vi.fn(async()=>({project:{source:{kind:'remote'}}}))},remote:{projectConversation:async()=>({read,close:async()=>{}})},executionResource:async(id:string)=>'/native/'+id,log:vi.fn()} as any;
 const conversation={id:'conversation',boardId:'b',sessionId:'native',resourceId:'/native/original',binding:{projectId:'carrier',profileId:'codex'}} as any;
 const request=(method:string,params:Record<string,unknown>,id=method)=>resolveDecisionRequest(options,conversation,{id,scopeId:conversation.id,method,params});
 return {options,conversation,service,request,read,runRecord,fixTask};
}
it('keeps a remote multi-project proposal outside the board until real user confirmation',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'outline',title:'Outline',content:'Requirements',rationale:'Acceptance',projectIds:['one','two'],verificationMode:'quick'}) as any;
 expect((await f.service.records('b')).total).toBe(0);
 expect(proposal.record).toMatchObject({discussionSessionId:'/native/original',completion:'automatic',verificationLevel:'quick',deliveryMode:'release',externalRefs:[{id:'one'},{id:'two'}]});expect(f.runRecord).not.toHaveBeenCalled();
 await expect(f.request('decision.confirm',{proposalDigest:proposal.proposalDigest})).rejects.toMatchObject({code:'DECISION_USER_CONFIRMATION_REQUIRED'});
 f.read.mockResolvedValue({messages:[{id:'user-2',role:'user',text:'确认决策'}]});await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 expect(await f.service.record('b','outline')).toMatchObject({status:'confirmed'});expect(f.runRecord).toHaveBeenCalledWith('b',expect.objectContaining({recordId:'outline',operationId:'decision-run-conversation'}));
});
it('discovers and invokes diagnostics through the native request route using the bound project',async()=>{
 const f=await fixture(),{serviceDiagnosticsPlugins}=await import('../src/kanban/service-diagnostics-plugin');
 const {resolveKanbanPluginRequest}=await import('../src/kanban/session-request-plugins');
 const read=vi.fn(async()=>({records:[],sources:{httpd:'read',cells:'read'}}));
 const remote={list:vi.fn(()=>[{at:'/',serverId:'node',serverProjectId:'p',authorization:{principalId:'owner'},alias:'prj',root:'/src',mountId:'root'}]),
  projectRemountOptions:vi.fn(async()=>({path:'src',alias:'prj'}))};
 f.options.requestPlugins=()=>serviceDiagnosticsPlugins({readDiagnosticsForProject:read} as never,remote as never,'carrier');
 const call=(method:string,params:Record<string,unknown>,id=method)=>resolveKanbanPluginRequest(f.options,f.conversation,{id,scopeId:'conversation',method,params});
 await expect(call('kanban.discover',{})).resolves.toMatchObject({plugins:expect.arrayContaining([{id:'service-diagnostics',version:'1',description:expect.any(String)}])});
 const params={pluginId:'service-diagnostics',method:'read',input:{requestId:'req'}};
 await expect(call('kanban.invoke',params)).resolves.toMatchObject({records:[]});
 expect(read).toHaveBeenCalledExactlyOnceWith({serverId:'node',serverProjectId:'p',principalId:'owner',alias:'prj',root:'/src'},'carrier',{requestId:'req'});
 await expect(call('kanban.invoke',{...params,input:{requestId:'req',projectId:'other'}},'retry'))
  .rejects.toMatchObject({code:'SERVICE_DIAGNOSTICS_QUERY_INVALID'});
 expect(read).toHaveBeenCalledOnce();
});
it('previews the chosen schedule and never launches a one-off run when confirming or retrying a scheduled decision',async()=>{
 const f=await fixture(),recurrence={state:'active',firstAt:Date.now()+60000,timeZone:'UTC',cadence:{kind:'interval',milliseconds:60000},trigger:'fixed',maxConcurrency:1};
 f.conversation.recurrence=recurrence;
 const proposal=await f.request('decision.propose',{id:'scheduled',title:'Maintenance',content:'Check',rationale:'Verified',projectIds:['one'],verificationMode:'quick'}) as any;
 expect(proposal.record.recurrence).toEqual(recurrence);
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 const params={proposalDigest:proposal.proposalDigest};
 await expect(f.request('decision.confirm',params)).resolves.toMatchObject({state:'confirmed',executionMode:'recurring'});
 const record=await f.service.record('b','scheduled');
 expect(record).toMatchObject({status:'confirmed',recurrence});
 await f.service.execute('b',{operationId:'disable-schedule',expectedRevision:(await f.service.read('b')).revision,
    command:{type:'configure-record-recurrence',recordId:record.id,expectedRecordRevision:record.revision,recurrence:null}});
 await f.request('decision.confirm',params);
 expect((await f.service.record('b','scheduled')).recurrence).toBeUndefined();
 expect(f.runRecord).not.toHaveBeenCalled();
});
it('routes fixes to the original group Session and never creates them in the decision conversation',async()=>{
 const f=await fixture();let serial=0;const run=async(command:any)=>f.service.execute('b',{operationId:'op-'+ ++serial,expectedRevision:(await f.service.read('b')).revision,command});
 const proposal=await f.request('decision.propose',{id:'outline',title:'Outline',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 await run({type:'create-item',item:{id:'group',title:'Group',responsibility:'Coordinate',acceptance:'Accepted'},planning:{kind:'task',execution:'children',priority:2,dependencies:[],references:[]}});
 await run({type:'create-item',item:{id:'child',title:'Child',responsibility:'Develop',acceptance:'Checked'},planning:{kind:'subtask',parentId:'group',priority:2,dependencies:[],references:[]}});await run({type:'link-record',recordId:'outline',itemId:'group'});
 const before=(await f.service.read('b')).items;expect(await f.request('decision.open-coordination',{itemId:'child'})).toMatchObject({groupItemId:'group',resourceId:'/native/original-group-session'});
 expect(f.fixTask).toHaveBeenCalledWith('b',expect.objectContaining({itemId:'group'}));expect((await f.service.read('b')).items).toEqual(before);
 await expect(f.request('decision.add-fix',{itemId:'child'})).rejects.toMatchObject({code:'DECISION_REQUEST_UNSUPPORTED'});
});

it('passes the selected management run to the coordination resolver',async()=>{
 const f=await fixture();let serial=0;const run=async(command:any)=>f.service.execute('b',{operationId:'round-'+ ++serial,expectedRevision:(await f.service.read('b')).revision,command});
 const proposal=await f.request('decision.propose',{id:'outline',title:'Outline',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 for(const id of ['first','second']){await run({type:'create-item',item:{id,title:id,responsibility:'Coordinate',acceptance:'Checked'},planning:{kind:'task',execution:'children',priority:2,dependencies:[],references:[]}});await run({type:'link-record',recordId:'outline',itemId:id});}
 const openRecordCoordination=vi.fn(async()=>({sessionId:'second-session'}));
 f.options.client=()=>({...f.service,openRecordCoordination,recordExecutions:async()=>[{id:'run-first',boardId:'b',rootItemId:'first'},{id:'run-second',boardId:'b',rootItemId:'second'}]});
 expect(await f.request('decision.open-coordination',{itemId:'second'})).toEqual({sessionId:'second-session'});
 expect(openRecordCoordination).toHaveBeenCalledWith('b',expect.objectContaining({recordId:'outline',runId:'run-second'}));
});

it('accepts automatic replacement without verification from the conversation API',async()=>{
 const f=await fixture();const proposal=await f.request('decision.propose',{id:'mail-read',title:'Mail read state',content:'Mark opened mail as read',rationale:'Sidebar reflects read state',projectIds:['one'],verificationMode:'release'}) as any;
 expect(proposal.record).toMatchObject({verificationLevel:'none',deliveryMode:'release',completion:'automatic'});
 expect((await f.service.records('b')).total).toBe(0);
});

it('leaves no decision when discussion stops, restores the preview and rejects an obsolete confirmation',async()=>{
 const f=await fixture(),input={id:'preview',title:'Preview',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'};
 expect(await f.request('decision.read',{})).toMatchObject({record:null,total:0});
 const first=await f.request('decision.propose',input,'preview-1') as any;
 expect(await f.request('decision.read',{})).toMatchObject({record:null,proposal:{proposalDigest:first.proposalDigest}});
 expect((await f.service.records('b')).total).toBe(0);expect((await f.service.read('b')).items).toHaveLength(0);
 const second=await f.request('decision.propose',{...input,content:'Changed scope'},'preview-2') as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await expect(f.request('decision.confirm',{proposalDigest:first.proposalDigest},'stale')).rejects.toMatchObject({code:'DECISION_PROPOSAL_CHANGED'});
 expect((await f.service.records('b')).total).toBe(0);
 await f.request('decision.confirm',{proposalDigest:second.proposalDigest},'accepted');
 await f.request('decision.confirm',{proposalDigest:second.proposalDigest},'accepted');
 expect((await f.service.records('b')).total).toBe(1);
 expect(await f.service.record('b','preview')).toMatchObject({status:'confirmed',content:'Changed scope'});
});

it.each([
 [undefined,'none','build-cleanup'],['build-cleanup','none','build-cleanup'],['full','full','release'],['quick','quick','release'],['release','none','release'],['build','none','build'],['source','none','source'],
])('preserves the %s delivery choice when the preview becomes a confirmed decision',async(mode,verificationLevel,deliveryMode)=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'choice',title:'Choice',content:'Scope',rationale:'Check',projectIds:['one'],...(mode===undefined?{}:{verificationMode:mode})}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 expect(await f.service.record('b','choice')).toMatchObject({status:'confirmed',verificationLevel,deliveryMode,completion:'automatic'});
});

it('preserves an explicitly chosen primary and rejects scope or Cell changes before confirmation',async()=>{
 const f=await fixture();f.conversation.binding={...f.conversation.binding,projectId:'one',projectIds:['one','two']};
 let changed=false;f.options.remote.list=(id:string)=>[{at:'/',serverId:changed&&id==='two'?'other':'cell',serverProjectId:id,serverProjectRevision:1,authorization:{principalId:'owner',revision:'auth'}}];
 const input={id:'scope',title:'Scope',content:'Requirements',rationale:'Acceptance',projectIds:['one','two'],verificationMode:'quick'};
 await expect(f.request('decision.propose',{...input,projectIds:['one','outside']})).rejects.toMatchObject({code:'DECISION_PROJECT_SCOPE_MISMATCH'});
 const proposal=await f.request('decision.propose',input) as any;
 expect(proposal.record.externalRefs).toContainEqual({system:'nestos-primary-project',id:'one'});
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});changed=true;
 await expect(f.request('decision.confirm',{proposalDigest:proposal.proposalDigest})).rejects.toMatchObject({code:'DECISION_PROJECT_CELL_MISMATCH'});
 expect((await f.service.records('b')).total).toBe(0);expect(f.runRecord).not.toHaveBeenCalled();
});
it('recovers an existing Session after post-create failure without inventing one for a pre-create failure',async()=>{
 const {decisionConversationViews}=await import('../src/kanban/decision-conversation-views'),f=await fixture();
 f.options.projects.get.mockResolvedValue({path:'/main'});
 await f.options.journal.update('decision-native:created',()=>({sessionId:'original'}));
 await f.options.journal.update('record-conversation:created',()=>({binding:{projectId:'main',profileId:'codex'}}));
 await f.options.journal.update('decision-conversation-proposal:created',()=>({record:{title:'Original draft'}}));
 const rows=await decisionConversationViews(f.options,[{id:'created',boardId:'b',state:'error',createdAt:1,code:'EIO'},{id:'not-created',boardId:'b',state:'error',createdAt:2,code:'ECONFLICT'}]);
 expect(rows[0]).toMatchObject({sessionId:'original',resourceId:'/folder:main/@harness/codex/original',title:'Original draft'});
 expect(rows[1].sessionId).toBeUndefined();expect(rows[1].resourceId).toBeUndefined();expect(f.options.projects.get).toHaveBeenCalledOnce();
});

it('requires an actual user cancellation, retains the cancelled draft and rejects later confirmation',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'draft',title:'Draft',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 expect(await f.request('decision.read',{})).toMatchObject({state:'draft',actions:{cancel:{method:'decision.cancel',params:{},confirmation:'取消决策'}}});
 await expect(f.request('decision.cancel',{})).rejects.toMatchObject({code:'DECISION_CANCEL_CONFIRMATION_REQUIRED'});
 expect(await f.options.journal.get('decision-conversation-cancellation:conversation')).toBeUndefined();
 f.read.mockResolvedValue({messages:[{id:'cancel',role:'assistant',text:'取消决策'}]});await expect(f.request('decision.cancel',{})).rejects.toMatchObject({code:'DECISION_CANCEL_CONFIRMATION_REQUIRED'});
 f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 const receipt=await f.request('decision.cancel',{},'cancel-draft');expect(receipt).toMatchObject({state:'cancelled',sessionId:'native',resourceId:'/native/original',retainedSession:true,nextAction:'none'});
 expect(await f.request('decision.cancel',{},'retry')).toEqual(receipt);
 const {decisionConversationViews}=await import('../src/kanban/decision-conversation-views');
 const recovered=(await decisionConversationViews(f.options,[{...f.conversation,state:'error',code:'EIO',createdAt:1}]))[0];expect(recovered.state).toBe('cancelled');expect(recovered.code).toBeUndefined();
 expect(await f.request('decision.read',{})).toMatchObject({state:'cancelled',record:null,proposal:{proposalDigest:proposal.proposalDigest}});
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await expect(f.request('decision.confirm',{proposalDigest:proposal.proposalDigest})).rejects.toMatchObject({code:'DECISION_CONVERSATION_CANCELLED'});
 await expect(f.request('decision.propose',{id:'different'})).rejects.toMatchObject({code:'DECISION_CONVERSATION_CANCELLED'});
 expect((await f.service.records('b')).total).toBe(0);expect((await f.service.read('b')).items).toHaveLength(0);expect(f.runRecord).not.toHaveBeenCalled();
});
it('cancels an empty discussion without creating a proposal or accepting another target',async()=>{
 const f=await fixture();f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 await expect(f.request('decision.cancel',{recordId:'outside'})).rejects.toMatchObject({code:'INVALID_DECISION_CANCELLATION'});
 expect(await f.request('decision.cancel',{})).toMatchObject({state:'cancelled',retainedSession:true});
 expect(await f.options.journal.get('decision-conversation-proposal:conversation')).toBeUndefined();expect((await f.service.records('b')).total).toBe(0);
});
it('retries a failed cancellation with its frozen operation and reads the real settlement state',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'live',title:'Live',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 const controlRecord=vi.fn().mockRejectedValueOnce(Object.assign(Error('PRIVATE_FAILURE'),{code:'EIO'})).mockImplementation(async(board,request)=>{await f.service.execute(board,{operationId:request.operationId,expectedRevision:(await f.service.read(board)).revision,command:{type:'request-record-cancellation',recordId:request.recordId}});});
 f.options.client=()=>({...f.service,controlRecord});f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 await expect(f.request('decision.cancel',{},'cancel-live')).rejects.toMatchObject({code:'EIO'});
 f.read.mockRejectedValue(Error('Must not require authorization again for a frozen retry'));
 expect(await f.request('decision.cancel',{},'cancel-live')).toMatchObject({state:'cancelling',recordId:'live',nextAction:'wait-for-settlement'});
 expect(controlRecord.mock.calls[0][1]).toEqual(controlRecord.mock.calls[1][1]);expect(controlRecord.mock.calls[1][1]).toMatchObject({recordId:'live',action:'cancel'});
 await f.service.execute('b',{operationId:'settled',expectedRevision:(await f.service.read('b')).revision,command:{type:'cancel-record',recordId:'live'}});
 expect(await f.request('decision.read',{})).toMatchObject({state:'cancelled',record:{status:'cancelled'}});
 expect(await f.request('decision.cancel',{},'later')).toMatchObject({state:'cancelled',retainedSession:true});expect(controlRecord).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(f.options.log.mock.calls)).not.toContain('PRIVATE_FAILURE');
});
it('supports the cancellation phrase in older policy files without losing their existing choices',async()=>{
 const {conversationPolicy}=await import('../src/kanban/conversation-policy'),f=await fixture();
 const defaults=(await import('../src/resources/catalog')).kanbanConversationPolicy,{cancelDecision,...legacy}=defaults;
 await f.options.fs.driver.createFile({parentPath:'/etc/kanban/development',name:'conversation-policy.json',content:JSON.stringify({...legacy,confirmDecision:'Custom confirm'}),recursive:true});
 expect(await conversationPolicy(f.options.fs)).toMatchObject({confirmDecision:'Custom confirm',cancelDecision:'取消决策'});
});
it('recovers a committed decision whose link receipt was lost before cancelling it',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'committed',title:'Committed',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 await f.service.execute('b',{operationId:'committed',expectedRevision:(await f.service.read('b')).revision,command:{type:'append-record',record:proposal.record}});
 const controlRecord=vi.fn(async(board,request)=>{for(const type of ['request-record-cancellation','cancel-record'])await f.service.execute(board,{operationId:request.operationId+type,expectedRevision:(await f.service.read(board)).revision,command:{type,recordId:request.recordId} as any});});
 f.options.client=()=>({...f.service,controlRecord});f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 expect(await f.request('decision.cancel',{})).toMatchObject({recordId:'committed',state:'cancelled'});expect(controlRecord).toHaveBeenCalledOnce();
 expect(await f.request('decision.read',{})).toMatchObject({state:'cancelled',record:{id:'committed',status:'cancelled'}});expect((await f.service.records('b')).total).toBe(1);
});
it('does not report cancellation as complete when the control port returns without changing domain state',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'live',title:'Live',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 f.options.client=()=>({...f.service,controlRecord:vi.fn(async()=>{})});f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 await expect(f.request('decision.cancel',{})).rejects.toMatchObject({code:'DECISION_CANCELLATION_UNCONFIRMED'});
 expect(await f.request('decision.read',{})).toMatchObject({state:'cancelling',code:'DECISION_CANCELLATION_UNCONFIRMED',record:{status:'confirmed'}});
});

it('blocks decision mutation while errors remain, preserves the proposal, then resumes the same decision',async()=>{
 const {conversationIssuesKey}=await import('../src/run/conversation-issues');
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'resume',title:'Resume',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'}) as any;
 const key=conversationIssuesKey(f.conversation.id),issue={type:'error',origin:{sessionId:'native',turnId:'a',operationId:'op-a'}};
 await f.options.journal.update(key,()=>({seen:{},issues:{error:issue},resolved:[],rejected:{},acknowledged:[]}));
 const current=await f.request('decision.read',{}) as any;expect(current).toMatchObject({state:'blocked',pendingReports:[{id:'error'}],proposal:{proposalDigest:proposal.proposalDigest}});
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await expect(f.request('decision.confirm',{proposalDigest:proposal.proposalDigest})).rejects.toMatchObject({code:'DECISION_SESSION_BLOCKED'});
 expect((await f.service.records('b')).total).toBe(0);expect(f.runRecord).not.toHaveBeenCalled();
 await f.options.journal.update(key,(old:any)=>({...old,resolved:['error']}));
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 expect((await f.service.records('b')).total).toBe(1);expect(f.runRecord).toHaveBeenCalledOnce();
});
it('allows explicit cancellation of a blocked decision draft without creating a record',async()=>{
 const f=await fixture();await f.options.journal.update('conversation-issues:conversation',()=>({seen:{},issues:{error:{type:'error',origin:{sessionId:'native',turnId:'a',operationId:'op'}}},resolved:[],rejected:{},acknowledged:[]}));
 f.read.mockResolvedValue({messages:[{id:'cancel',role:'user',text:'取消决策'}]});
 expect(await f.request('decision.cancel',{})).toMatchObject({state:'cancelled'});
 expect((await f.service.records('b')).total).toBe(0);
});

it('projects proposal activity from durable changes and keeps it stable across rereads and identical proposals',async()=>{
 const {decisionConversationViews}=await import('../src/kanban/decision-conversation-views'),f=await fixture();
 const time=vi.spyOn(Date,'now').mockReturnValue(10000);
 const params={id:'draft',title:'Draft',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'quick'};
 const rows=[{...f.conversation,state:'clarifying',createdAt:1}];
 try{
  await f.request('decision.propose',params);
  expect((await decisionConversationViews(f.options,rows))[0].lastActivityAt).toBe(10000);
  time.mockReturnValue(20000);await f.request('decision.propose',params);
  expect((await decisionConversationViews(f.options,rows))[0].lastActivityAt).toBe(10000);
  await f.request('decision.propose',{...params,title:'Revised draft'});
  expect((await decisionConversationViews(f.options,rows))[0].lastActivityAt).toBe(20000);
 }finally{time.mockRestore();}
});
it('discovers plugin schemas on demand, queries prerequisites and freezes dependency references in the confirmed decision',async()=>{
 const f=await fixture(),{resolveKanbanPluginRequest}=await import('../src/kanban/session-request-plugins');
 f.conversation.binding.projectId='one';
 const call=(method:string,params:any={},id=method)=>resolveKanbanPluginRequest(f.options,f.conversation,{id,scopeId:'conversation',method,params});
 const discovery=await call('kanban.discover') as any;expect(discovery.plugins.map((row:any)=>row.id)).toEqual(['decisions']);expect(JSON.stringify(discovery)).not.toContain('inputSchema');
 expect(await call('kanban.describe',{pluginId:'decisions',method:'propose'})).toMatchObject({inputSchema:{properties:{dependsOn:{type:'array'}}}});
 await f.service.execute('b',{operationId:'server-create',expectedRevision:(await f.service.read('b')).revision,command:{type:'append-record',record:{id:'server',kind:'decision',title:'WebDAV Server',content:'Server',rationale:'Check',itemIds:[],sources:[],externalRefs:[{system:'nestos-remote-project',id:'one'}]}}});
 await f.service.execute('b',{operationId:'server-confirm',expectedRevision:(await f.service.read('b')).revision,command:{type:'review-record',recordId:'server',accept:true}});
 expect(await call('kanban.invoke',{pluginId:'decisions',method:'search',input:{query:'WebDAV'}})).toMatchObject({decisions:[{id:'server',completed:false}]});
 const proposal=await call('kanban.invoke',{pluginId:'decisions',method:'propose',input:{id:'client',title:'Client',content:'Mount',rationale:'Check',projectIds:['one'],verificationMode:'release',dependsOn:[{boardId:'b',recordId:'server'}]}},'preview-client') as any;
 expect(proposal.record.dependsOn).toEqual([{boardId:'b',recordId:'server',title:'WebDAV Server'}]);
 f.read.mockResolvedValue({messages:[{id:'confirm-client',role:'user',text:'确认决策'}]});
 await call('kanban.invoke',{pluginId:'decisions',method:'confirm',input:{proposalDigest:proposal.proposalDigest}},'confirm-client');
 expect(await f.service.record('b','client')).toMatchObject({status:'confirmed',dependsOn:[{boardId:'b',recordId:'server'}]});
});
it('lists only authorized decisions with stable cursors and rejects a stale cursor',async()=>{
 const f=await fixture(),{resolveKanbanPluginRequest}=await import('../src/kanban/session-request-plugins');
 f.conversation.binding.projectId='one';
 const call=(input:any,id:string)=>resolveKanbanPluginRequest(f.options,f.conversation,{id,scopeId:'conversation',method:'kanban.invoke',params:{pluginId:'decisions',method:'list',input}}) as Promise<any>;
 for(const [id,projects] of [['a',['one']],['b',['two']],['c',['one','two']]] as const){
  await f.service.execute('b',{operationId:'list-create-'+id,expectedRevision:(await f.service.read('b')).revision,command:{type:'append-record',record:{id,kind:'decision',title:id,content:'Scope',rationale:'Check',itemIds:[],sources:[],externalRefs:projects.map(project=>({system:'nestos-remote-project',id:project}))}}});
 }
 const first=await call({limit:1},'list-first');expect(first.total).toBe(2);expect(first.decisions).toHaveLength(1);expect(first.nextCursor).toBeTruthy();
 const second=await call({limit:1,cursor:first.nextCursor},'list-second');
 expect([...first.decisions,...second.decisions].map(row=>row.id).sort()).toEqual(['a','c']);
 expect([...first.decisions,...second.decisions].flatMap(row=>row.projectIds)).toEqual(['one','one']);
 await f.service.execute('b',{operationId:'list-create-d',expectedRevision:(await f.service.read('b')).revision,command:{type:'append-record',record:{id:'d',kind:'decision',title:'d',content:'Scope',rationale:'Check',itemIds:[],sources:[],externalRefs:[{system:'nestos-remote-project',id:'one'}]}}});
 await expect(call({limit:1,cursor:first.nextCursor},'list-stale')).rejects.toMatchObject({code:'CURSOR_STALE'});
});
it('adds a scoped host plugin without adding a top-level MCP tool or eagerly exposing its schema',async()=>{
 const f=await fixture(),{resolveKanbanPluginRequest}=await import('../src/kanban/session-request-plugins'),run=vi.fn(async()=>({state:'ok'}));
 f.options.requestPlugins=()=>[{id:'example',version:'1',description:'Example capability',methods:[{id:'inspect',kind:'query',description:'Inspect',inputSchema:{type:'object',properties:{selection:{type:'string'}}},run}]}];
 const invoke=(method:string,params:any)=>resolveKanbanPluginRequest(f.options,f.conversation,{id:'request',scopeId:'conversation',method,params});
 const available=await invoke('kanban.discover',{});expect(JSON.stringify(available)).not.toContain('selection');
 expect(await invoke('kanban.invoke',{pluginId:'example',method:'inspect',input:{selection:'known'}})).toEqual({state:'ok'});
 expect(run).toHaveBeenCalledWith(expect.objectContaining({id:'request',params:{selection:'known'}}));
 await expect(invoke('kanban.invoke',{pluginId:'unknown',method:'inspect',input:{}})).rejects.toMatchObject({code:'CHANNEL_PLUGIN_UNAVAILABLE'});
 const plugin=f.options.requestPlugins()[0];f.options.requestPlugins=()=>[{...plugin,version:'2'}];
 await expect(invoke('kanban.invoke',{pluginId:'example',method:'inspect',input:{selection:'known'}})).rejects.toMatchObject({code:'CHANNEL_PLUGIN_VERSION_CHANGED'});expect(run).toHaveBeenCalledOnce();
});
it('keeps real confirmation valid across a proven host continuation but rejects a later real user message',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'continued',title:'Continued',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'release'}) as any;
 await f.options.journal.update('decision-response:conversation:describe-confirm:resumed',()=>true);
 f.read.mockResolvedValue({messages:[{id:'real-confirm',turnId:'user-turn',role:'user',text:'确认决策'},{id:'host-message',turnId:'host-turn',role:'user',text:'Read the host response and continue.'}],instructionQueue:{submissions:[{id:'reply-describe-confirm',turnId:'host-turn'}]}} as any);
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest},'confirm-continued');
 expect((await f.service.record('b','continued')).status).toBe('confirmed');
 const g=await fixture(),second=await g.request('decision.propose',{id:'blocked',title:'Blocked',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:'release'}) as any;
 g.read.mockResolvedValue({messages:[{id:'confirm',turnId:'u1',role:'user',text:'确认决策'},{id:'do-not-confirm',turnId:'u2',role:'user',text:'Wait'}],instructionQueue:{submissions:[{id:'reply-unproven',turnId:'u2'}]}} as any);
 await expect(g.request('decision.confirm',{proposalDigest:second.proposalDigest})).rejects.toMatchObject({code:'DECISION_USER_CONFIRMATION_REQUIRED'});expect(g.runRecord).not.toHaveBeenCalled();
});

it('requires a plugin ID and describes cleanup with separate plugin and method routing',async()=>{
 const f=await fixture(),{resolveKanbanPluginRequest}=await import('../src/kanban/session-request-plugins');
 Object.assign(f.conversation.binding,{purpose:'coordination',recordId:'record'});
 const call=(method:string,params:any)=>resolveKanbanPluginRequest(f.options,f.conversation,{id:'cleanup-route',scopeId:'conversation',method,params});
 for(const method of ['kanban.describe','kanban.invoke'])await expect(call(method,{method:'delivery.cleanup.complete',input:{reviewId:'review'}})).rejects.toMatchObject({code:'CHANNEL_PLUGIN_ID_REQUIRED'});
 expect(await call('kanban.describe',{pluginId:'delivery',method:'cleanup.complete'})).toMatchObject({pluginId:'delivery',id:'cleanup.complete',inputSchema:{required:['reviewId']}});
 await expect(call('kanban.describe',{pluginId:'delivery',method:'delivery.cleanup.complete'})).rejects.toMatchObject({code:'CHANNEL_PLUGIN_METHOD_UNAVAILABLE'});
});

it('keeps the host-selected module version in the preview and the confirmed record',async()=>{
 const f=await fixture(),module={id:'software-development',version:'1',label:'Software approvals'};
 f.conversation.binding.modules=[module];
 const proposal=await f.request('decision.propose',{id:'module-approval',title:'Approved scope',content:'Check',rationale:'Work',projectIds:['one'],verificationMode:'source',moduleIds:['fake']}) as any;
 expect(proposal.modules).toEqual([module]);
 expect(proposal.record.externalRefs).toContainEqual({system:'nestos-decision-module',id:module.id,revision:module.version});
 expect(proposal.record.externalRefs).not.toContainEqual(expect.objectContaining({id:'fake'}));
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 expect((await f.service.record('b','module-approval')).externalRefs).toEqual(proposal.record.externalRefs);
});

it('persists the operator stage choices through confirmation and excludes the already bound discussion choice',async()=>{
 const f=await fixture();
 f.conversation.harnesses={decision:'discussion-harness',coordination:'planning-harness',execution:'worker-harness'};
 const proposal=await f.request('decision.propose',{id:'harness-choice',title:'Stages',content:'Scope',rationale:'Check',projectIds:['one']}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 const saved=await f.service.record('b','harness-choice');
 expect(saved.externalRefs).toEqual([
    {system:'nestos-remote-project',id:'one'},
    {system:'nestos-decision-harness-coordination',id:'planning-harness'},
    {system:'nestos-decision-harness-execution',id:'worker-harness'},
 ]);
});

it('confirms a manually started decision once and never creates a run during confirmation or replay',async()=>{
 const f=await fixture();f.conversation.manualStart=true;f.conversation.harnesses={execution:'manual-worker'};
 const proposal=await f.request('decision.propose',{id:'manual-start',title:'Manual',content:'Scope',rationale:'Check',projectIds:['one']}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 const params={proposalDigest:proposal.proposalDigest};
 for(let retry=0;retry<2;retry++)await expect(f.request('decision.confirm',params,'manual-confirm')).resolves.toMatchObject({state:'confirmed',executionMode:'manual'});
 expect(f.runRecord).not.toHaveBeenCalled();
 expect(await f.service.record('b','manual-start')).toMatchObject({status:'confirmed',manualStart:true,itemIds:[],
    externalRefs:expect.arrayContaining([{system:'nestos-decision-harness-execution',id:'manual-worker'}])});
});


it('writes one task change remark and its confirmation source with the confirmed edit',async()=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'edit-scope',title:'Initial',content:'Scope',rationale:'Check',projectIds:['one']}) as any;
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:'确认决策'}]});
 await f.request('decision.confirm',{proposalDigest:proposal.proposalDigest});
 let serial=0;const command=async(command:any)=>f.service.execute('b',{operationId:'setup-'+ ++serial,expectedRevision:(await f.service.read('b')).revision,command});
 await command({type:'create-item',item:{id:'work',title:'Initial',responsibility:'Build',acceptance:'Done'},
    planning:{kind:'task',priority:2,dependencies:[],references:[]}});
 await command({type:'link-record',recordId:'edit-scope',itemId:'work'});
 const record=await f.service.record('b','edit-scope'),{item}=await f.service.item('b','work');
 const editId='conversation-adjust';
 const held=await f.request('decision.begin-edit',{editId,recordRevision:record.revision,items:[{id:item.id,revision:item.revision}]}) as any;
 const updated={editId,recordRevision:held.record.revision,title:'Updated',content:'Expanded scope',rationale:'Updated tests',
    changeSummary:'Include the alternate project flow.',items:[{id:item.id,revision:held.items[0].revision,title:'Updated',responsibility:'Build both flows',acceptance:'Check both paths'}]};
 await expect(f.request('decision.apply-edit',updated,'apply')).rejects.toMatchObject({code:'DECISION_USER_CONFIRMATION_REQUIRED'});
 f.read.mockResolvedValue({messages:[{id:'confirmed-change',role:'user',text:'确认调整'}]});
 await f.request('decision.apply-edit',updated,'apply');await f.request('decision.apply-edit',updated,'apply');
 const notes=(await f.service.events('b','latest',200)).filter(event=>event.kind==='message'&&event.itemId==='work');
 expect(notes).toHaveLength(1);
 expect(notes[0].data).toMatchObject({message:updated.changeSummary,recordId:'edit-scope',requirementChange:{revision:held.record.revision+1,
    source:{sessionId:'/native/original',messageId:'confirmed-change'}}});
 expect((await f.service.item('b','work')).item.acceptance).toBe('Check both paths');
});

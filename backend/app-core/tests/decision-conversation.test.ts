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
 ['full','full','release'],['quick','quick','release'],['release','none','release'],['build','none','build'],['source','none','source'],
])('preserves the %s delivery choice when the preview becomes a confirmed decision',async(mode,verificationLevel,deliveryMode)=>{
 const f=await fixture(),proposal=await f.request('decision.propose',{id:'choice',title:'Choice',content:'Scope',rationale:'Check',projectIds:['one'],verificationMode:mode}) as any;
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

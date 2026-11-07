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

import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {previewExecutionCheckWaiver,confirmExecutionCheckWaiver} from '../src/kanban/execution-check-waiver';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const item:any={id:'task',status:'claimed',revision:3,acceptance:'Build; live verify',planning:{parentId:'root'},owner:{token:'fence'},externalRefs:[{system:'nestos-native-session',id:'executor',revision:JSON.stringify({projectId:'p',profileId:'codex',dispatchId:'dispatch'})}]};
 const board={id:'b',revision:1,items:[{id:'root'},item]},record={id:'decision',status:'confirmed',itemIds:['root']};
 const service={read:vi.fn(async()=>board),record:async()=>record,item:async()=>({item}),workflow:async()=>({dispatches:{dispatch:{id:'dispatch',itemId:'task',attempt:1,outcome:'running',fence:'fence'}}}),execute:vi.fn(async(_b,request)=>{item.executionCheckWaivers=[{...request.command.waiver,dispatchId:'dispatch',acceptance:item.acceptance,actor:{kind:'human',id:'admin'},at:1}];})};
 const read=vi.fn(async()=>({messages:[{id:'user',role:'user',text:'Not confirmed'}]})),enqueue=vi.fn(async()=>{}),open=vi.fn(async()=>({read,enqueue,close:async()=>{}}));
 const options={journal,service,remote:{projectConversation:open},log:vi.fn()} as any;
 const conversation={id:'manager',boardId:'b',sessionId:'manager-native',binding:{purpose:'coordination',recordId:'decision',projectId:'p',profileId:'codex'}} as any;
 const request=(id:string,params:any)=>({id,scopeId:'manager',params}) as any;
 const preview=()=>previewExecutionCheckWaiver(options,conversation,request('preview',{itemId:'task',checks:['Live verify'],reason:'User waives until after deployment'}));
 return {options,conversation,item,record,read,enqueue,open,service,request,preview};
}
it('requires exact user approval, preserves the original executor and resumes once after the host waiver receipt',async()=>{
 const f=await fixture(),preview=await f.preview(),request=f.request('confirm',{previewId:preview.previewId});
 await expect(confirmExecutionCheckWaiver(f.options,f.conversation,request)).rejects.toMatchObject({code:'WAIVER_USER_CONFIRMATION_REQUIRED'});expect(f.service.execute).not.toHaveBeenCalled();
 f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:preview.confirmation}]});
 expect(await confirmExecutionCheckWaiver(f.options,f.conversation,request)).toMatchObject({state:'waived',receipt:{checks:['Live verify']}});
 await confirmExecutionCheckWaiver(f.options,f.conversation,request);expect(f.service.execute).toHaveBeenCalledOnce();expect(f.enqueue).toHaveBeenCalledOnce();
 expect(f.open).toHaveBeenCalledWith('p','codex','executor');expect(f.item.status).toBe('claimed');
});
it('retries only the same notification after a lost acknowledgement without duplicating the domain command',async()=>{
 const f=await fixture(),preview=await f.preview();f.read.mockResolvedValue({messages:[{id:'confirm',role:'user',text:preview.confirmation}]});
 f.enqueue.mockRejectedValueOnce(Object.assign(Error('lost'),{code:'EIO'}));const request=f.request('confirm',{previewId:preview.previewId});
 await expect(confirmExecutionCheckWaiver(f.options,f.conversation,request)).rejects.toMatchObject({code:'EIO'});
 await confirmExecutionCheckWaiver(f.options,f.conversation,request);expect(f.service.execute).toHaveBeenCalledOnce();expect(f.enqueue.mock.calls[0]).toEqual(f.enqueue.mock.calls[1]);
});
it('rejects foreign tasks, changed conversations and inactive decisions',async()=>{
 const f=await fixture();await expect(previewExecutionCheckWaiver(f.options,f.conversation,f.request('foreign',{itemId:'foreign',checks:['check'],reason:'reason'}))).rejects.toMatchObject({code:'ITEM_NOT_IN_DECISION'});
 const preview=await f.preview();f.conversation.sessionId='other';await expect(confirmExecutionCheckWaiver(f.options,f.conversation,f.request('confirm',{previewId:preview.previewId}))).rejects.toMatchObject({code:'WAIVER_SCOPE_MISMATCH'});
 f.record.status='cancelled';await expect(f.preview()).rejects.toMatchObject({code:'DECISION_NOT_ACTIVE'});
});

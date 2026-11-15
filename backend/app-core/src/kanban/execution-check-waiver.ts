import {sha256HexSync} from '@nestos/common';
import {itemsWithinRoots,journalCommand,safeCode} from '@nestos/kanban/integration';
import {verificationWaiverConfirmation,verificationWaiverInstruction} from '@nestos/kanban-development';
import type {KanbanCommand,KanbanExecutionCheckWaiver} from '@nestos/kanban/contracts';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {ChannelRequest} from '../run/channel-protocol';
import {requireUserConfirmation} from './decision-conversation-confirmation';
import {requireValue} from './validation';
type Command=Extract<KanbanCommand,{type:'waive-execution-checks'}>;
interface Preview {id:string;owner:string;sessionId:string;boardId:string;recordId:string;command:Command;projectId:string;profileId:string;nativeSessionId:string}
const key=(id:string)=>'execution-check-waiver:'+id;
export async function previewExecutionCheckWaiver(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest){
 const {itemId,checks,reason}=request.params;
 requireValue(typeof itemId==='string'&&typeof reason==='string'&&reason.trim().length>0&&reason.length<=2000&&Array.isArray(checks)&&checks.length>0&&checks.length<=16&&checks.every(row=>typeof row==='string'&&row.trim().length>0&&row.length<=1000),'INVALID_CHECK_WAIVER');
 const {board,record}=await boundDecision(options,conversation);
 const item=itemsWithinRoots(board.items,record.itemIds).find(row=>row.id===itemId);requireValue(item&&!item.deletedAt&&item.status==='claimed','ITEM_NOT_IN_DECISION');
 const dispatch=Object.values((await options.service.workflow(board.id)).dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
 requireValue(dispatch?.outcome==='running'&&item.owner?.token===dispatch.fence,'STALE_EXECUTION_RESULT');
 const refs=item.externalRefs?.filter(row=>row.system==='nestos-native-session').map(row=>({id:row.id,binding:JSON.parse(row.revision??'{}') as {projectId?:string;profileId?:string;dispatchId?:string}})).filter(row=>row.binding.dispatchId===dispatch.id)??[];
 const native=refs[0];requireValue(native?.binding.projectId&&native.binding.profileId&&refs.every(row=>row.id===native.id&&row.binding.projectId===native.binding.projectId&&row.binding.profileId===native.binding.profileId),'CONTINUATION_NATIVE_SESSION_UNKNOWN');
 requireValue([conversation.binding.projectId,...conversation.binding.projectIds??[]].includes(native.binding.projectId),'DECISION_PROJECT_SCOPE_MISMATCH');
 const id='verify-waiver-'+sha256HexSync(JSON.stringify([conversation.id,request.id])).slice(0,48);
 const preview:Preview={id,owner:conversation.id,sessionId:conversation.sessionId!,boardId:board.id,recordId:record.id,projectId:native.binding.projectId,profileId:native.binding.profileId,nativeSessionId:native.id,
  command:{type:'waive-execution-checks',itemId:item.id,dispatchId:dispatch.id,expectedItemRevision:item.revision,waiver:{id,checks:checks as string[],reason:reason.trim()}}};
 const saved=await options.journal.update<Preview>(key(id),old=>{requireValue(!old||JSON.stringify(old)===JSON.stringify(preview),'CHANNEL_REQUEST_CHANGED');return old??preview;});
 return {previewId:saved.id,itemId,dispatchId:dispatch.id,checks,reason,acceptance:item.acceptance,confirmation:verificationWaiverConfirmation};
}
export async function confirmExecutionCheckWaiver(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest):Promise<{state:'waived';receipt:KanbanExecutionCheckWaiver;resourceId:string}>{
 const started=Date.now(),id=request.params.previewId;requireValue(typeof id==='string','INVALID_CHECK_WAIVER');
 const saved=await options.journal.get<Preview>(key(id));requireValue(saved&&saved.owner===conversation.id&&saved.sessionId===conversation.sessionId&&saved.boardId===conversation.boardId,'WAIVER_SCOPE_MISMATCH');
 await boundDecision(options,conversation);
 try{
  if(!await options.journal.get(key(id)+':authorized')){await requireUserConfirmation(options,conversation,request,verificationWaiverConfirmation,'WAIVER_USER_CONFIRMATION_REQUIRED');await options.journal.update(key(id)+':authorized',()=>true);}
  await journalCommand(options.journal,options.service,saved.boardId,id+':commit',saved.command);
  const item=(await options.service.item(saved.boardId,saved.command.itemId)).item,receipt=item.executionCheckWaivers?.find(row=>row.id===id);requireValue(receipt,'WAIVER_RECEIPT_MISSING');
  if(!await options.journal.get(key(id)+':notified')){
   const port=await options.remote.projectConversation(saved.projectId,saved.profileId,saved.nativeSessionId);
   try{requireValue(port.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await port.enqueue(verificationWaiverInstruction({boardId:saved.boardId,itemId:item.id,...receipt}),[],undefined,'reply-'+id,'next-turn');}finally{await port.close();}
   await options.journal.update(key(id)+':notified',()=>true);
  }
  options.log({operationId:id,boardId:saved.boardId,stage:'execution.checks.waive',result:'success',durationMs:Date.now()-started});
  return {state:'waived',receipt,resourceId:'/folder:'+saved.projectId+'/@harness/'+saved.profileId+'/'+saved.nativeSessionId};
 }catch(error){options.log({operationId:id,boardId:saved.boardId,stage:'execution.checks.waive',result:'failure',code:safeCode(error,'CHECK_WAIVER_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function boundDecision(options:DecisionConversationOptions,conversation:DecisionConversation){
 requireValue(conversation.binding.purpose==='coordination'&&conversation.binding.recordId,'WAIVER_SCOPE_MISMATCH');
 const board=await options.service.read(conversation.boardId),record=await options.service.record(board.id,conversation.binding.recordId);
 requireValue(!board.lifecycle&&!board.deletedAt&&record.status==='confirmed'&&!record.archivedAt&&!record.deletedAt,'DECISION_NOT_ACTIVE');
 return {board,record};
}

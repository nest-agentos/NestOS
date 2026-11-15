import {sha256HexSync} from '@nestos/common';
import type {KanbanItemOperationRequest,KanbanItemOperations} from '@nestos/kanban/contracts';
import {safeCode} from '@nestos/kanban/integration';
import {channelDigest,type ChannelRequest} from '../run/channel-protocol';
import {requireUserConfirmation} from './decision-conversation-confirmation';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {requireValue} from './validation';
type Input=Omit<KanbanItemOperationRequest,'operationId'|'itemId'|'confirmed'|'skip'|'cancel'>;
interface Saved {digest:string;request:KanbanItemOperationRequest}
/** The conversation delegates to the same scoped plugin and receipts as the manual UI. */
export async function coordinationOperations(options:DecisionConversationOptions,conversation:DecisionConversation,message:ChannelRequest,itemId:string) {
    const started=Date.now(),operationId='coordinate-operation-'+sha256HexSync(JSON.stringify([conversation.id,message.id]));
    const service=options.client();
    const stage=message.method==='coordination.operations.read'?'coordination.operations.read':'coordination.operations.run';
    try {
        requireValue(service.itemOperations,'ECAPABILITY');
        const value=stage==='coordination.operations.read'?await service.itemOperations(conversation.boardId,itemId):await run(options,conversation,message,itemId,operationId);
        options.log({operationId,boardId:conversation.boardId,stage,result:'success',durationMs:Date.now()-started});return value;
    }catch(error){options.log({operationId,boardId:conversation.boardId,stage,result:'failure',code:safeCode(error,'OPERATION_REQUEST_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function run(options:DecisionConversationOptions,conversation:DecisionConversation,message:ChannelRequest,itemId:string,operationId:string) {
    const service=options.client();requireValue(service.runItemOperation&&service.itemOperations,'ECAPABILITY');
    const digest=channelDigest(message),key='coordination-operation:'+operationId,saved=await options.journal.get<Saved>(key);
    if(saved){requireValue(saved.digest===digest,'CHANNEL_REQUEST_CHANGED');return service.runItemOperation(conversation.boardId,saved.request);}
    const input=operationInput(message.params.request),view=selectView(await service.itemOperations(conversation.boardId,itemId),input);
    requireValue(view.revision===input.expectedRevision,'OPERATION_STALE_REFRESH');
    const entry=view.operations.find(row=>(row.runAction??row.id)===input.action);requireValue(entry,'OPERATION_REQUEST_INVALID');
    if(input.reconcile)requireValue(input.reconcile.runId===entry.runId||input.reconcile.runId===entry.recovery?.runId,'OPERATION_SCOPE_MISMATCH');
    else requireValue(entry.enabled&&entry.state!=='unknown'&&entry.state!=='running','OPERATION_PREREQUISITE_REQUIRED');
    const confirmation=input.reconcile?undefined:input.followUp?entry.followUp?.confirmation:entry.confirmation;
    if(input.followUp)requireValue(entry.followUp?.action===input.followUp,'OPERATION_REQUEST_INVALID');
    if(confirmation)await requireUserConfirmation(options,conversation,message,confirmation,'OPERATION_CONFIRMATION_REQUIRED');
    const request={...input,operationId,itemId,...(confirmation?{confirmed:true}:{})};
    const admitted=await options.journal.update<Saved>(key,old=>{requireValue(!old||old.digest===digest,'CHANNEL_REQUEST_CHANGED');return old??{digest,request};});
    return service.runItemOperation(conversation.boardId,admitted.request);
}
function operationInput(value:unknown):Input {
    requireValue(value&&typeof value==='object'&&!Array.isArray(value),'OPERATION_REQUEST_INVALID');
    const input=value as Input,allowed=['action','expectedRevision','pluginId','scopeId','selections','followUp','reconcile'];
    requireValue(Object.keys(input).every(key=>allowed.includes(key))&&typeof input.action==='string'&&typeof input.expectedRevision==='string'&&JSON.stringify(input).length<=16384,'OPERATION_REQUEST_INVALID');
    requireValue(input.reconcile===undefined||input.reconcile&&typeof input.reconcile==='object'&&!Array.isArray(input.reconcile)
        &&Object.keys(input.reconcile).every(key=>key==='runId')&&typeof input.reconcile.runId==='string'&&/^[\w-]{1,128}$/.test(input.reconcile.runId),'OPERATION_REQUEST_INVALID');
    requireValue(input.selections===undefined||input.selections&&typeof input.selections==='object'&&!Array.isArray(input.selections)
        &&Object.values(input.selections).every(value=>typeof value==='string'),'OPERATION_REQUEST_INVALID');
    return input;
}
function selectView(root:KanbanItemOperations,input:Input):KanbanItemOperations {
    requireValue(input.pluginId||!root.plugins?.length,'OPERATION_PLUGIN_REQUIRED');
    const selected=input.pluginId?(root.pluginId===input.pluginId?root:root.plugins?.find(row=>row.id===input.pluginId)?.view):root;
    requireValue(selected,'OPERATION_PLUGIN_UNAVAILABLE');
    requireValue(input.scopeId||!selected.scopes?.length,'OPERATION_SCOPE_REQUIRED');
    const view=input.scopeId?selected.scopes?.find(row=>row.id===input.scopeId)?.view:selected;
    requireValue(view,'OPERATION_SCOPE_INVALID');return view;
}

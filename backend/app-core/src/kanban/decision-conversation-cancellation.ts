import type {KanbanRecordConversation} from '@nestos/kanban/contracts';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {ChannelRequest} from '../run/channel-protocol';
import {channelDigest} from '../run/channel-protocol';
import {requireUserConfirmation} from './decision-conversation-confirmation';
import {conversationPolicy} from './conversation-policy';
import {requireValue} from './validation';
import {advanceRecordCancellation,safeCode} from '@nestos/kanban/integration';

export interface DecisionCancellation {boardId:string;recordId?:string;operationId:string;code?:string;state:'cancelling'|'cancelled'}
export const decisionCancellationKey=(id:string)=>'decision-conversation-cancellation:'+id;

/** Cancellation retains the Session and can only control the decision bound by the host. */
export async function cancelDecisionConversation(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,link?:{recordId:string}) {
    requireValue(Object.keys(request.params).length===0,'INVALID_DECISION_CANCELLATION');
    const started=Date.now(),key=decisionCancellationKey(conversation.id);
    let intent=await options.journal.get<DecisionCancellation>(key);
    try {
        if(!intent){
            await requireUserConfirmation(options,conversation,request,(await conversationPolicy(options.fs)).cancelDecision,'DECISION_CANCEL_CONFIRMATION_REQUIRED');
            const recordId=await cancellationTarget(options,conversation,link);
            const operationId='decision-cancel-'+channelDigest({conversationId:conversation.id,requestId:request.id});
            intent=await options.journal.update<DecisionCancellation>(key,old=>old??{boardId:conversation.boardId,recordId,operationId,state:recordId?'cancelling':'cancelled'});
        }
        requireValue(options.active?.()!==false,'SERVICE_STOPPING');
        await advanceCancellation(options,intent);
        const state=await cancellationView(options,{...intent,code:undefined});
        await options.journal.update<DecisionCancellation>(key,old=>({...old!,state:state.state as DecisionCancellation['state'],code:undefined}));
        options.log({operationId:intent.operationId,boardId:conversation.boardId,stage:'decision.cancel.'+state.state,result:'success',durationMs:Date.now()-started});
        return {...state,sessionId:conversation.sessionId,resourceId:conversation.resourceId,retainedSession:true,nextAction:state.state==='cancelled'?'none':'wait-for-settlement'};
    }catch(error){
        const code=safeCode(error,'DECISION_CANCEL_FAILED');
        options.log({operationId:intent?.operationId??request.id,boardId:conversation.boardId,stage:'decision.cancel',result:'failure',code,durationMs:Date.now()-started});
        if(intent)await options.journal.update<DecisionCancellation>(key,old=>({...old!,code}));throw error;
    }
}

async function advanceCancellation(options:DecisionConversationOptions,intent:DecisionCancellation):Promise<void> {
    if(!intent.recordId||intent.state==='cancelled')return;
    await advanceRecordCancellation(options.client(),intent.boardId,intent.recordId,intent.operationId);
}

export async function conversationCancellationState(options:Pick<DecisionConversationOptions,'journal'|'service'>,id:string):Promise<Pick<KanbanRecordConversation,'state'|'recordId'|'code'>|undefined> {
    const intent=await options.journal.get<DecisionCancellation>(decisionCancellationKey(id));
    if(!intent)return;
    return cancellationView(options,intent);
}
export async function cancellationView(options:Pick<DecisionConversationOptions,'service'>,intent:DecisionCancellation):Promise<Pick<KanbanRecordConversation,'state'|'recordId'|'code'>> {
    if(!intent.recordId)return {state:'cancelled',code:undefined};
    const record=await options.service.record(intent.boardId,intent.recordId);
    return {recordId:intent.recordId,state:record.status==='cancelled'?'cancelled':'cancelling',code:record.status==='cancelled'?undefined:intent.code};
}

async function cancellationTarget(options:DecisionConversationOptions,conversation:DecisionConversation,link?:{recordId:string}):Promise<string|undefined> {
    if(link)return link.recordId;
    const proposal=await options.journal.get<{record:{id:string};proposalDigest:string}>('decision-conversation-proposal:'+conversation.id);
    if(!proposal)return;
    let record;
    try{record=await options.service.record(conversation.boardId,proposal.record.id);}
    catch(error){if((error as {code?:string})?.code==='RECORD_NOT_FOUND')return;throw error;}
    requireValue(record.discussionSessionId===conversation.resourceId&&!!conversation.resourceId,'DECISION_CANCELLATION_SCOPE_MISMATCH');
    await options.journal.update('decision-conversation-record:'+conversation.id,old=>old??{recordId:record.id,state:record.status==='draft'?'draft':'confirmed',proposalDigest:proposal.proposalDigest});
    return record.id;
}

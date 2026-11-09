import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {ChannelRequest} from '../run/channel-protocol';
import {requireValue} from './validation';

export async function requireUserConfirmation(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,text:string,errorCode='DECISION_USER_CONFIRMATION_REQUIRED'):Promise<void> {
    const port=await options.remote.projectConversation(conversation.binding.projectId,conversation.binding.profileId,conversation.sessionId);
    try {
        const snapshot=await port.read(),message=snapshot.messages.filter(row=>row.role==='user').at(-1);
        requireValue(message?.text.trim()===text,errorCode);
        const key='decision-confirmation:'+conversation.id+':'+message.id;
        await options.journal.update<{requestId:string}>(key,old=>{requireValue(!old||old.requestId===request.id,'DECISION_CONFIRMATION_ALREADY_USED');return old??{requestId:request.id};});
    }finally{await port.close();}
}

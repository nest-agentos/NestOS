import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {ChannelRequest} from '../run/channel-protocol';
import {requireValue} from './validation';

export async function requireUserConfirmation(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,text:string,errorCode='DECISION_USER_CONFIRMATION_REQUIRED'):Promise<void> {
    const port=await options.remote.projectConversation(conversation.binding.projectId,conversation.binding.profileId,conversation.sessionId);
    try {
        const snapshot=await port.read();
        const replies=snapshot.instructionQueue?.submissions?.filter(row=>row.turnId&&row.id.startsWith('reply-'))??[];
        const resumed=replies.length?await options.journal.getMany<boolean>(replies.map(row=>'decision-response:'+conversation.id+':'+row.id.slice(6)+':resumed')):[];
        const hostTurns=new Set(replies.flatMap((row,index)=>resumed[index]?[row.turnId]:[]));
        const message=snapshot.messages.filter(row=>row.role==='user'&&(!row.turnId||!hostTurns.has(row.turnId))).at(-1);
        requireValue(message?.text.trim()===text,errorCode);
        const key='decision-confirmation:'+conversation.id+':'+message.id;
        await options.journal.update<{requestId:string}>(key,old=>{requireValue(!old||old.requestId===request.id,'DECISION_CONFIRMATION_ALREADY_USED');return old??{requestId:request.id};});
    }finally{await port.close();}
}

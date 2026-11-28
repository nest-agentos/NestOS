import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {ChannelRequest} from '../run/channel-protocol';
import type {HarnessMessage} from '@nestos/cells-driver';
import {requireValue} from './validation';

export async function readDecisionUserMessages(options:DecisionConversationOptions,conversation:DecisionConversation) {
    const port=await options.remote.projectConversation(conversation.binding.projectId,conversation.binding.profileId,conversation.sessionId,undefined,true);
    try {
        const snapshot=await port.read({includeUsage:false}),submissions=snapshot.instructionQueue?.submissions??[];
        const replies=submissions.filter(row=>row.turnId&&row.id.startsWith('reply-'));
        const resumed=replies.length?await options.journal.getMany<boolean>(replies.map(row=>'decision-response:'+conversation.id+':'+row.id.slice(6)+':resumed')):[];
        const hostTurns=new Set(replies.flatMap((row,index)=>resumed[index]?[row.turnId]:[]));
        const bootstrap=submissions.find(row=>row.id===conversation.binding.inputId)?.turnId;
        if(bootstrap)hostTurns.add(bootstrap);
        return snapshot.messages.filter(row=>row.role==='user'&&(!row.turnId||!hostTurns.has(row.turnId))).flatMap(userText);
    }finally{await port.close();}
}

/** The native adapter may emit injected context under the user role. */
function userText(message:HarnessMessage):HarnessMessage[] {
    const {contentPartKinds:kinds,contentParts:parts}=message;
    if(!kinds?.length||kinds.length!==parts?.length)return [message];
    const selected=parts.filter((_,index)=>kinds[index]==='user.text');
    return selected.length?[{...message,text:selected.join('\n')}]:[];
}

export async function requireUserConfirmation(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,text:string,errorCode='DECISION_USER_CONFIRMATION_REQUIRED',basisMessageId?:string):Promise<string> {
    const messages=await readDecisionUserMessages(options,conversation),message=messages.at(-1);
    requireValue(message?.text.trim()===text,errorCode);
    if(basisMessageId)requireValue(messages.slice(0,-1).filter(row=>row.text.trim()!==text).at(-1)?.id===basisMessageId,'DECISION_PROPOSAL_CHANGED');
    const key='decision-confirmation:'+conversation.id+':'+message.id;
    await options.journal.update<{requestId:string}>(key,old=>{requireValue(!old||old.requestId===request.id,'DECISION_CONFIRMATION_ALREADY_USED');return old??{requestId:request.id};});
    return message.id;
}

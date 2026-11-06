import {createRecordConversations,safeCode} from '@nestos/kanban/integration';
import {channelRequests,channelDigest,type ChannelResponse} from '../run/channel-protocol';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {decisionConversationTransport,resumeDecisionConversation} from './decision-conversation-transport';
import {resolveDecisionRequest,decisionConversationState} from './decision-conversation-requests';

export function decisionConversations(options:DecisionConversationOptions) {
    const port=decisionConversationTransport(options,async (value,active)=>{
        const conversation=value as DecisionConversation;
        const pending=channelRequests(await options.remote.sessionChannel(conversation.binding.projectId,'requests',{scopeId:conversation.id}),conversation.id);
        for(const row of pending) {
            if(!active())break;
            const started=Date.now(),key='decision-response:'+conversation.id+':'+row.request.id;
            let response=await options.journal.get<ChannelResponse>(key);
            if(!response) {
                try{response={id:row.request.id,scopeId:conversation.id,requestDigest:row.requestDigest,status:'ok',payload:await resolveDecisionRequest({...options,active},conversation,row.request),error:null};}
                catch(error){const code=safeCode(error,'DECISION_REQUEST_FAILED');
                    options.log({operationId:row.request.id,boardId:conversation.boardId,stage:'decision.request.resolve',result:'failure',code,durationMs:Date.now()-started});
                    if(['EIO','HTTP_CONNECTION_LOST','ETIMEOUT','SERVICE_STOPPING'].includes(code))throw error;
                    response={id:row.request.id,scopeId:conversation.id,requestDigest:row.requestDigest,status:'error',payload:null,error:{code}};}
                response=await options.journal.update<ChannelResponse>(key,old=>old??response!);
            }
            if(!row.response) {
                const published=await options.remote.sessionChannel(conversation.binding.projectId,'respond',response as unknown as Record<string,unknown>);
                if(channelDigest(published)!==channelDigest(response))throw Object.assign(new Error('Changed response'),{code:'CHANNEL_RESPONSE_CHANGED'});
                options.log({operationId:row.request.id,boardId:conversation.boardId,stage:'decision.request.response',result:response.status==='ok'?'success':'failure',code:response.error?.code,durationMs:Date.now()-started});
            }
            if(active()&&!await options.journal.get<boolean>(key+':resumed')){await resumeDecisionConversation(options,conversation,row.request.id);await options.journal.update(key+':resumed',()=>true);}
        }
        return {state:value.state==='error'?'clarifying':value.state,...await decisionConversationState(options,conversation.id),code:undefined};
    });
    return createRecordConversations({...options,port});
}

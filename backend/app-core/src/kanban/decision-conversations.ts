import {recordCoordination} from './record-coordination';
import {resolveCoordinationRequest} from './coordination-conversation-requests';
import {readConversationIssues} from '../run/conversation-issues';
import {decisionConversationViews} from './decision-conversation-views';
import {createRecordConversations,safeCode} from '@nestos/kanban/integration';
import {channelRequests,channelDigest,type ChannelResponse} from '../run/channel-protocol';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {decisionConversationTransport,resumeDecisionConversation} from './decision-conversation-transport';
import {resolveDecisionRequest,decisionConversationState} from './decision-conversation-requests';

export function decisionConversations(options:DecisionConversationOptions) {
    const port=decisionConversationTransport(options,async (value,active)=>{
        const conversation=value as DecisionConversation,started=Date.now();
        let reports:{pendingReports:Array<{id:string;type:'error'|'clarification'}>;code?:string}={pendingReports:[]};
        if(conversation.sessionId){const issues=await readConversationIssues(options.remote,conversation.binding.projectId,conversation.id,conversation.sessionId,options.journal);
            reports=issues;
            if(JSON.stringify(issues.pendingReports)!==JSON.stringify(conversation.pendingReports??[]))options.log({operationId:conversation.id,boardId:conversation.boardId,stage:issues.pendingReports.length?'decision.reports.blocked':'decision.reports.resolved',result:issues.code==='DECISION_SESSION_ERROR_REPORTED'?'failure':'success',code:issues.code,durationMs:Date.now()-started});}

        const pending=channelRequests(await options.remote.sessionChannel(conversation.binding.projectId,'requests',{scopeId:conversation.id}),conversation.id);
        for(const row of pending) {
            if(!active())break;
            const started=Date.now(),key='decision-response:'+conversation.id+':'+row.request.id;
            let response=await options.journal.get<ChannelResponse>(key);
            if(!response) {
                try{response={id:row.request.id,scopeId:conversation.id,requestDigest:row.requestDigest,status:'ok',payload:JSON.parse(JSON.stringify(await (conversation.binding.purpose==='coordination'?resolveCoordinationRequest:resolveDecisionRequest)({...options,active},conversation,row.request))),error:null};}
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
        return conversation.binding.purpose==='coordination'?{recordId:conversation.binding.recordId,state:reports.pendingReports.length?'blocked':'confirmed',purpose:'coordination',...reports}:decisionConversationState(options,conversation.id,conversation.boardId);
    });
    const conversations=createRecordConversations({...options,port});
    return {openRecordCoordination:recordCoordination(options,conversations),startRecordConversation:conversations.startRecordConversation,scan:conversations.scan,quiesce:conversations.quiesce,recordConversations:async(boardId:string)=>{
        return decisionConversationViews(options,await conversations.recordConversations(boardId));
    }};
}

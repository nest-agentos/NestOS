import {conversationIssuesKey,conversationIssueView,type ConversationIssueState} from '../run/conversation-issues';
import {decisionCancellationKey,cancellationView,type DecisionCancellation} from './decision-conversation-cancellation';
import {remoteSessionPath} from '@nestos/app-contracts';
import type {KanbanRecordConversation} from '@nestos/kanban/contracts';
import type {DecisionConversationOptions,DecisionConversationBinding} from './decision-conversation-ports';

/** Recover known Session identities even when enqueueing failed before the public receipt was saved. */
export async function decisionConversationViews(options:DecisionConversationOptions,rows:KanbanRecordConversation[]):Promise<KanbanRecordConversation[]> {
    const values=await options.journal.getMany<unknown>(rows.flatMap(row=>['decision-conversation-proposal:'+row.id,'decision-native:'+row.id,'record-conversation:'+row.id,decisionCancellationKey(row.id),conversationIssuesKey(row.id)]));
    const folders=new Map<string,ReturnType<DecisionConversationOptions['projects']['get']>>();
    return Promise.all(rows.map(async(row,index)=>{
        const proposal=values[index*5] as {record?:{title?:string}}|undefined;
        const native=values[index*5+1] as {sessionId?:string}|undefined;
        const saved=values[index*5+2] as {binding?:DecisionConversationBinding}|undefined;
        const title=proposal?.record?.title,sessionId=row.sessionId??native?.sessionId,binding=saved?.binding;
        const cancellation=values[index*5+3] as DecisionCancellation|undefined;
        const state=cancellation?await cancellationView(options,cancellation):undefined;
        const reports=conversationIssueView(values[index*5+4] as ConversationIssueState|undefined);
        const recovered=row.state==='blocked'&&!reports.pendingReports.length?{state:row.recordId?'confirmed' as const:proposal?'draft' as const:'clarifying' as const,code:undefined}:{};
        const view={...row,...(binding?.purpose==='coordination'?{purpose:'coordination' as const,recordId:binding.recordId}:{}),...recovered,...(reports.pendingReports.length&&!['cancelled','cancelling'].includes(row.state)?reports:{pendingReports:[]}),...state,...(title?{title}:{}),...(sessionId?{sessionId}:{})};
        if(!sessionId||view.resourceId||!binding)return view;
        const started=Date.now();
        try {
            if(!folders.has(binding.projectId))folders.set(binding.projectId,options.projects.get(binding.projectId));
            const folder=await folders.get(binding.projectId)!;
            return {...view,resourceId:remoteSessionPath(folder.path,binding.profileId,sessionId)};
        }catch(error){
            const raw=(error as {code?:string})?.code,code=raw&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'DECISION_SESSION_LINK_FAILED';
            options.log({operationId:row.id,boardId:row.boardId,stage:'decision.conversation.link',result:'failure',code,durationMs:Date.now()-started});
            return view;
        }
    }));
}

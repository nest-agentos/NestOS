import {formatPromptSections} from '@nestos/llm-context/prompt';
import type {KanbanClient} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {taskReplies as createReplies,type KanbanAutomationJournal,type FrozenReply as Reply} from '@nestos/kanban/integration';
import type {SubmissionRequest} from '@nestos/llm-session/contracts';

import {requireValue} from './validation';
interface ReplyBinding {sessionId:string;submission:SubmissionRequest}
export type FrozenReply=Reply<ReplyBinding>;
export function taskReplies(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions) {
    return createReplies<ReplyBinding>(service,journal,{
        prepare:async({dispatch,request})=>{
            requireValue(options.enqueueTaskReply&&options.sessionChannel&&dispatch.executionSessionId,'WORKSPACE_REPLY_UNAVAILABLE');
            const workspace=await journal.get<{worktreeId?:string}>('development-workspace:'+dispatch.id);
            requireValue(workspace,'WORKSPACE_REPLY_UNAVAILABLE');
            const calls=await options.calls.list({sessionId:workspace.worktreeId??dispatch.id});
            const call=calls.find(row=>row.receipt.executionSessionId===dispatch.executionSessionId);requireValue(call,'CONTINUATION_SESSION_UNKNOWN');
            const original=await options.originalSession(call.input);requireValue(original.sessionId===dispatch.executionSessionId,'CONTINUATION_SCOPE_MISMATCH');
            const text=formatPromptSections([{title:'User reply',content:request.content},{title:'Reply binding',content:{scopeId:request.attemptId,replyTo:request.replyTo,operationId:request.operationId}}]);
            return {sessionId:original.sessionId,submission:original.request(request.operationId,text)};
        },deliver:async frozen=>{
            requireValue(frozen.submission&&options.enqueueTaskReply,'WORKSPACE_REPLY_BINDING_REQUIRED');
            await options.enqueueTaskReply(frozen.submission);
        }});
}

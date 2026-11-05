import {formatPromptSections} from '@nestos/llm-context';
import type {KanbanClient} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {taskReplies as createReplies,type KanbanAutomationJournal,type FrozenReply as Reply} from '@nestos/kanban/integration';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import {requireValue} from './validation';
interface ReplyBinding {sessionId:string;target:TargetRef;projectId:string;directory:string;runId:string}
export type FrozenReply=Reply<ReplyBinding>;
export function taskReplies(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions) {
    return createReplies<ReplyBinding>(service,journal,{
        prepare:async({item,dispatch})=>{
            requireValue(options.enqueueTaskReply&&options.sessionChannel&&dispatch.executionSessionId,'WORKSPACE_REPLY_UNAVAILABLE');
            const workspace=await journal.get<{projectId:string;directory:string}>('development-workspace:'+dispatch.id);
            const target=await journal.get<{target:TargetRef}>('managed-agent:work-'+dispatch.id);
            requireValue(workspace&&target,'WORKSPACE_REPLY_UNAVAILABLE');
            return {sessionId:dispatch.executionSessionId!,target:target.target,...workspace,
                runId:item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??dispatch.planId};
        },deliver:reply=>transferReply(options,reply)});
}
async function transferReply(options:PersonalKanbanAutomationOptions,frozen:FrozenReply):Promise<void> {
    const {request,target,sessionId}=frozen;
    await options.enqueueTaskReply!({expectedSessionId:sessionId,expectedBranch:'main',expectedTarget:target,
        target:{kind:target.kind,id:target.id,version:target.version},source:{kind:'composer',text:formatPromptSections([{title:'User reply',content:request.content},{title:'Reply binding',content:{scopeId:request.attemptId,replyTo:request.replyTo,operationId:request.operationId}}]),attachments:[],values:{}},
        submission:{id:request.operationId,source:{kind:'conversation',ownerId:sessionId,id:request.operationId}}});
}

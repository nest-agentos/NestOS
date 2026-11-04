import type {KanbanClient} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanAutomationJournal} from './automation-journal';
import type {TargetRef} from '@nestos/llm-flow/contracts';
import {publishFile} from '../run/prompt-bundle';
import {requireValue} from './validation';

export interface KanbanTaskReply {itemId:string;attemptId:string;replyTo:string;operationId:string;content:string}
interface FrozenReply {boardId:string;request:KanbanTaskReply;sessionId:string;target:TargetRef;projectId:string;directory:string;runId:string}
/** Files carry correlation; the existing Session input queue owns user input admission. */
export function taskReplies(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions) {
    const replyTask=async(boardId:string,request:KanbanTaskReply):Promise<void>=>{
        requireValue(/^[\w-]{1,96}$/.test(request.operationId)&&typeof request.content==='string'&&!!request.content.trim()&&request.content.length<=8000,'WORKSPACE_REPLY_INVALID');
        await service.item(boardId,request.itemId);
        const old=await journal.get<FrozenReply>('task-reply:'+request.operationId);
        requireValue(!old||old.boardId===boardId&&JSON.stringify(old.request)===JSON.stringify(request),'IDEMPOTENCY_CONFLICT');
        if(await journal.get('task-reply-delivered:'+request.operationId))return;
        const frozen=await freezeReply(service,journal,options,boardId,request);
        await journal.update<string[]>('task-reply-index',previous=>previous?.includes(request.operationId)?previous:[...previous??[],request.operationId]);
        await transferReply(options,frozen);
        await journal.update('task-reply-delivered:'+request.operationId,()=>true);
    };
    return Object.assign(replyTask,{async scan(){
        for(const id of await journal.get<string[]>('task-reply-index')??[]) {
            if(await journal.get('task-reply-delivered:'+id))continue;
            const saved=await journal.get<FrozenReply>('task-reply:'+id);if(saved)await replyTask(saved.boardId,saved.request);
        }
    }});
}
async function freezeReply(service:KanbanClient,journal:KanbanAutomationJournal,options:PersonalKanbanAutomationOptions,boardId:string,request:KanbanTaskReply):Promise<FrozenReply> {
    const {item}=await service.item(boardId,request.itemId),workflow=await service.workflow(boardId),dispatch=workflow.dispatches[request.attemptId];
    requireValue(dispatch?.itemId===item.id&&item.owner?.token===dispatch.fence&&['prepared','running','unknown'].includes(dispatch.outcome),'STALE_EXECUTION_RESULT');
    requireValue(item.issues?.some(issue=>issue.id===request.replyTo&&issue.attemptId===request.attemptId&&!issue.resolvedBy),'ISSUE_NOT_FOUND');
    requireValue(options.enqueueTaskReply&&options.projects?.openWorkspace&&dispatch.executionSessionId,'WORKSPACE_REPLY_UNAVAILABLE');
    const workspace=await journal.get<{projectId:string;directory:string}>('development-workspace:'+dispatch.id);
    const target=await journal.get<{target:TargetRef}>('managed-agent:work-'+dispatch.id);requireValue(workspace&&target,'WORKSPACE_REPLY_UNAVAILABLE');
    return journal.update<FrozenReply>('task-reply:'+request.operationId,old=>{
        requireValue(!old||old.boardId===boardId&&JSON.stringify(old.request)===JSON.stringify(request),'IDEMPOTENCY_CONFLICT');
        return old??{boardId,request:structuredClone(request),sessionId:dispatch.executionSessionId!,target:target.target,...workspace,
            runId:item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??dispatch.planId};
    });
}
async function transferReply(options:PersonalKanbanAutomationOptions,frozen:FrozenReply):Promise<void> {
    const {request,target,sessionId}=frozen,project=await options.projects!.get(frozen.projectId),view=await options.projects!.openWorkspace!(project.path);
    try {
        await publishFile(view.fs,frozen.directory+'/_nestos/kanban/outbox','reply-'+request.operationId+'.yaml',JSON.stringify({schema:'work-reply/1',runId:frozen.runId,
            itemId:request.itemId,attemptId:request.attemptId,id:'reply-'+request.operationId,type:'user-response',replyTo:request.replyTo,content:request.content}));
    }finally{await view.dispose();}
    await options.enqueueTaskReply!({expectedSessionId:sessionId,expectedBranch:'main',expectedTarget:target,
        target:{kind:target.kind,id:target.id,version:target.version},source:{kind:'composer',text:request.content,attachments:[],values:{}},
        submission:{id:request.operationId,source:{kind:'conversation',ownerId:sessionId,id:request.operationId}}});
}

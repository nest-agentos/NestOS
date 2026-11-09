import {randomUUID} from '@nestos/common';
import {requireValue} from './validation';
import {PRIMARY_PROJECT_REFERENCE,REMOTE_PROJECT_REFERENCE} from './resource-catalog';
import type {DecisionConversationOptions} from './decision-conversation-ports';
import type {KanbanRecordConversations} from '@nestos/kanban/integration';
/** One durable communication Session per decision, independent of planning/execution worktrees. */
export function recordCoordination(options:DecisionConversationOptions,conversations:KanbanRecordConversations) {
    return async(boardId:string,request:{recordId:string;operationId:string})=>{
        requireValue(/^[\w-]{1,128}$/.test(request.operationId),'INVALID_OPERATION_ID');
        const started=Date.now(),record=await options.service.record(boardId,request.recordId);
        requireValue(record.kind==='decision'&&record.status!=='draft'&&!record.deletedAt,'DECISION_NOT_CONFIRMED');
        const resources=record.externalRefs?.filter(ref=>ref.system===REMOTE_PROJECT_REFERENCE)??[];
        const primaryId=record.externalRefs?.find(ref=>ref.system===PRIMARY_PROJECT_REFERENCE)?.id??(resources.length===1?resources[0].id:undefined);
        requireValue(primaryId,'DECISION_PRIMARY_PROJECT_REQUIRED');
        const id=await options.journal.update<string>('record-coordination:'+JSON.stringify([boardId,record.id]),old=>old??randomUUID());
        await options.journal.update('record-coordination-scope:'+id,old=>old??{recordId:record.id});
        const saved=await options.journal.get<import('@nestos/kanban/integration').SavedRecordConversation>('record-conversation:'+id);
        if(saved?.sessionId&&saved.resourceId)return {id:saved.id,boardId,recordId:record.id,sessionId:saved.sessionId,resourceId:saved.resourceId,state:saved.state,createdAt:saved.createdAt,purpose:'coordination' as const};
        const result=await conversations.startRecordConversation(boardId,{operationId:id,resources,primaryResource:{system:REMOTE_PROJECT_REFERENCE,id:primaryId}});
        options.log({operationId:id,boardId,stage:'coordination.conversation.open',result:'success',durationMs:Date.now()-started});
        return {...result,recordId:record.id,purpose:'coordination' as const};
    };
}

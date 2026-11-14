import {conversationAttentionFingerprint,type KanbanClient} from '@nestos/kanban/contracts';
import {showConfirmDialog} from '@nestos/ui-common';
import {randomUUID,t} from '@nestos/common';

/** Remove only verified local discussion references after the user's confirmation. */
export function unavailableConversationCleanup(service:KanbanClient):(resourceId:string)=>Promise<boolean> {
    const requests=new Map<string,string>();return resourceId=>confirmUnavailableConversation(service,resourceId,requests);
}
export async function confirmUnavailableConversation(service:KanbanClient,resourceId:string,requests=new Map<string,string>()):Promise<boolean> {
    if(!service.controlRecordConversation)return false;
    const boards=await(service.catalog?.()??service.list());
    const discussions=await Promise.all(boards.map(async board=>({boardId:board.id,rows:await service.recordConversations?.(board.id)??[]})));
    const matches=discussions.flatMap(({boardId,rows})=>rows.filter(row=>row.resourceId===resourceId&&!row.recordId).map(row=>({boardId,row})));
    if(!await showConfirmDialog(t('kanban.cleanupConversationReferenceHelp'),{title:t('kanban.cleanupConversationReference'),confirmText:t('kanban.cleanupConversationReference'),cancelText:t('kanban.keepConversationReference')}))return false;
    for(const {boardId,row} of matches){const fingerprint=conversationAttentionFingerprint(row),key=JSON.stringify([boardId,row.id,fingerprint]);
        if(!requests.has(key))requests.set(key,randomUUID());
        await service.controlRecordConversation(boardId,{conversationId:row.id,operationId:requests.get(key)!,action:'cleanup-reference',fingerprint,confirmed:true});}
    return true;
}

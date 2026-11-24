import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {requireValue} from './validation';
import {kanbanReference} from '@nestos/kanban/contracts';
/** List uses the record store's revision-bound cursor and project filter. */
export async function listDecisions(options:DecisionConversationOptions,conversation:DecisionConversation,params:Record<string,unknown>) {
    const boardId=typeof params.boardId==='string'?params.boardId:conversation.boardId;
    const limit=params.limit===undefined?20:params.limit;
    requireValue(Number.isInteger(limit)&&Number(limit)>0&&Number(limit)<=50,'DECISION_QUERY_INVALID');
    requireValue(params.cursor===undefined||typeof params.cursor==='string'&&params.cursor.length<=4096,'DECISION_QUERY_INVALID');
    const projects=[...new Set(conversation.binding.projectIds??[conversation.binding.projectId])].sort();
    requireValue(projects.length>0,'DECISION_QUERY_INVALID');
    const board=await options.service.read(boardId);
    const page=await options.client().records(boardId,{kind:'decision',includeArchived:true,limit:Number(limit),
        resources:projects.map(id=>({system:'nestos-remote-project',id})),...(params.cursor?{cursor:params.cursor as string}:{})});
    return {boardId,total:page.total,revision:page.revision,nextCursor:page.nextCursor,decisions:page.items.map(row=>({
        id:row.id,reference:kanbanReference(board,row),title:row.title,status:row.status,revision:row.revision,
        completed:row.progress?.state==='completed'&&!row.progress.followUps?.length,
        projectIds:row.externalRefs?.filter(ref=>ref.system==='nestos-remote-project'&&projects.includes(ref.id)).map(ref=>ref.id)}))};
}
/** Queries expose authorized summaries only; reading never starts or creates a Session. */
export async function queryDecisions(options:DecisionConversationOptions,conversation:DecisionConversation,params:Record<string,unknown>) {
    const boardId=typeof params.boardId==='string'?params.boardId:conversation.boardId,client=options.client();
    requireValue(params.query===undefined||typeof params.query==='string'&&params.query.length<=200,'DECISION_QUERY_INVALID');
    const board=await options.service.read(boardId),page=await client.records(boardId,{kind:'decision',includeArchived:true,limit:200});
    const projects=conversation.binding.projectIds??[conversation.binding.projectId],query=String(params.query??'').trim().toLocaleLowerCase();
    const limit=params.limit===undefined?20:params.limit;requireValue(Number.isInteger(limit)&&Number(limit)>0&&Number(limit)<=50,'DECISION_QUERY_INVALID');
    const matches=page.items.filter(row=>row.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&projects.includes(ref.id))&&(!query||row.title.toLocaleLowerCase().includes(query)||row.id.toLocaleLowerCase().includes(query)));
    return {boardId,total:matches.length,decisions:matches.slice(0,Number(limit)).map(row=>({id:row.id,reference:kanbanReference(board,row),title:row.title,status:row.status,revision:row.revision,dependsOn:row.dependsOn??[],progress:row.progress,
        completed:row.progress?.state==='completed'&&!row.progress.followUps?.length,projectIds:row.externalRefs?.filter(ref=>ref.system==='nestos-remote-project').map(ref=>ref.id)}))};
}

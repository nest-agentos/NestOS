import {safeCode} from '@nestos/kanban/integration';
import {requireValue} from './validation';
import type {DecisionConversationOptions} from './decision-conversation-ports';
/** All entry points resolve the management task's retained Session; reading never creates one. */
export function recordCoordination(options:DecisionConversationOptions) {
    return async(boardId:string,request:{recordId:string;operationId:string})=>{
        const started=Date.now();
        try{
        requireValue(/^[\w-]{1,128}$/.test(request.operationId),'INVALID_OPERATION_ID');
        const record=await options.service.record(boardId,request.recordId);
        requireValue(record.kind==='decision'&&record.status!=='draft'&&!record.deletedAt,'DECISION_NOT_CONFIRMED');
        const client=options.client(),targets=new Map<string,{boardId:string;itemId:string}>();
        for(const itemId of record.itemIds){const {item,archive}=await client.item(boardId,itemId);if(archive||item.deletedAt||item.status==='cancelled')continue;if(item.purpose==='planning'||item.planning?.execution==='children')targets.set(JSON.stringify([boardId,itemId]),{boardId,itemId});}
        for(const run of await client.recordExecutions?.(boardId,record.id)??[])if(run.rootItemId&&run.archivedAt===undefined&&run.state!=='cancelled')targets.set(JSON.stringify([run.boardId,run.rootItemId]),{boardId:run.boardId,itemId:run.rootItemId});
        requireValue(targets.size===1,targets.size?'MANAGEMENT_SESSION_SELECTION_REQUIRED':'MANAGEMENT_SESSION_NOT_READY');
        const target=[...targets.values()][0],session=await client.planningSession?.(target.boardId,target.itemId);
        requireValue(session?.resourceId&&session.sessionId,'MANAGEMENT_SESSION_NOT_READY');
        options.log({operationId:request.operationId,boardId,stage:'coordination.conversation.resolve',result:'success',durationMs:Date.now()-started});
        return {id:session.analysisId,boardId:target.boardId,recordId:record.id,sessionId:session.sessionId,resourceId:session.resourceId,
            state:session.state==='waiting-input'?'blocked' as const:'confirmed' as const,createdAt:session.createdAt??record.createdAt,purpose:'coordination' as const};
        }catch(error){options.log({operationId:request.operationId,boardId,stage:'coordination.conversation.resolve',result:'failure',code:safeCode(error,'MANAGEMENT_SESSION_UNAVAILABLE'),durationMs:Date.now()-started});throw error;}
    };
}

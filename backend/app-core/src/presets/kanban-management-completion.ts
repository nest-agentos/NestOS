import {fullyWaivedDevelopmentDelivery,type ReviewJob,type ReviewSettings} from '@nestos/kanban-development';
import {reviewKey,jobKey,deliveryKey,deliveryComplete,type AutomaticDeliveryState,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanItem,KanbanWorkflowState} from '@nestos/kanban/contracts';
import type {ManagementContribution} from './kanban-management-scope-catalog';
/** Adopt explicit historical waivers without manufacturing integration or cleanup receipts. */
export async function waivedManagementDelivery(journal:KanbanAutomationJournal,board:KanbanBoard,owner:KanbanItem,rows:ManagementContribution[],workflow:KanbanWorkflowState,scopeId:string):Promise<boolean> {
    if(owner.status!=='completed'||!rows.length||!rows.every(row=>{
        const item=board.items.find(item=>item.id===row.itemId);
        return item&&fullyWaivedDevelopmentDelivery(item,Object.values(workflow.dispatches).find(dispatch=>dispatch.id===row.dispatchId));
    }))return false;
    const saved=await journal.get<string[]>('management-operation-scopes:'+JSON.stringify([board.id,owner.id]))??[];
    const scopes=[...new Set([...saved,scopeId])],keys=[reviewKey(board.id,owner.id),...scopes.map(id=>reviewKey(board.id,owner.id,id))];
    keys.push(...rows.map(row=>reviewKey(board.id,row.itemId)));
    const settings=await journal.getMany<ReviewSettings>(keys),jobs=await journal.getMany<ReviewJob>([...new Set(settings.flatMap(row=>row?.jobs??[]))].map(jobKey));
    if(!jobs.every(job=>job?.phase==='settled'))return false;
    const states=await journal.getMany<AutomaticDeliveryState>([deliveryKey(board.id,owner.id),...scopes.map(id=>deliveryKey(board.id,owner.id,id))]);
    for(const state of states){if(!state||deliveryComplete(state))continue;
        for(const request of Object.values(state.requests)){const job=await journal.get<ReviewJob>(jobKey(request.operationId));
            if(job?.phase==='settled')continue;
            if(job||request.action!=='analyze'||state.code!=='WORKTREE_MISSING')return false;
        }
    }
    return true;
}

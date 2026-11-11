import {reserveJournalResource,releaseJournalResource} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {jobKey,reviewKey,type ReviewSettings,type ReviewJob} from './item-operation-types';
export interface DeliveryScope {scopeId?:string;id:string;boardId:string;itemId:string;target?:string}
interface Ports {service:KanbanService;journal:KanbanAutomationJournal}
const key=(target:string)=>'automatic-target:'+JSON.stringify(target);
/** Reserve a business target across asynchronous jobs, without holding a storage transaction open. */
export async function claimDeliveryTarget(ports:Ports,scope:DeliveryScope):Promise<boolean>{
    if(!scope.target)return true;
    return reserveJournalResource(ports.journal,key(scope.target),binding(scope),owner=>releasable(ports,owner),sameBinding);
}
export async function releaseDeliveryTarget(ports:Ports,scope:DeliveryScope):Promise<void>{
    if(scope.target)await releaseJournalResource(ports.journal,key(scope.target),binding(scope),sameBinding);
}
const binding=({id,boardId,itemId,target,scopeId}:DeliveryScope):DeliveryScope=>({id,boardId,itemId,target,scopeId});
const sameBinding=(left:DeliveryScope,right:DeliveryScope)=>left.boardId===right.boardId&&left.itemId===right.itemId&&left.target===right.target&&left.scopeId===right.scopeId;
async function releasable(ports:Ports,scope:DeliveryScope):Promise<boolean> {
    const state=await ports.journal.get<{done?:boolean}>('automatic-delivery:'+JSON.stringify(scope.scopeId?[scope.boardId,scope.itemId,scope.scopeId]:[scope.boardId,scope.itemId]));
    if(state?.done)return true;
    let stopped=false;
    try{const detail=await ports.service.item(scope.boardId,scope.itemId);stopped=!!detail.archive||detail.item.deletedAt!==undefined||detail.item.status==='cancelled';}
    catch(error){if(!['BOARD_NOT_FOUND','ITEM_NOT_FOUND'].includes((error as {code:string}).code))throw error;stopped=true;}
    if(!stopped)return false;
    const settings=await ports.journal.get<ReviewSettings>(reviewKey(scope.boardId,scope.itemId,scope.scopeId));
    const jobs=await ports.journal.getMany<ReviewJob>((settings?.jobs??[]).map(jobKey));
    return jobs.every(job=>job?.phase==='settled');
}

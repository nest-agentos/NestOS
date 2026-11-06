import type {KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {jobKey,reviewKey,type ReviewSettings,type ReviewJob} from './item-operation-types';
export interface DeliveryScope {id:string;boardId:string;itemId:string;target?:string}
interface Ports {service:KanbanService;journal:KanbanAutomationJournal}
const key=(target:string)=>'automatic-target:'+JSON.stringify(target);
/** Reserve a business target across asynchronous jobs, without holding a storage transaction open. */
export async function claimDeliveryTarget(ports:Ports,scope:DeliveryScope):Promise<boolean> {
    if(!scope.target)return true;
    const owner=await ports.journal.update<DeliveryScope|null>(key(scope.target),old=>old??scope);
    if(owner!.id===scope.id)return true;
    if(!await releasable(ports,owner!))return false;
    const claimed=await ports.journal.update<DeliveryScope|null>(key(scope.target),old=>old?.id===owner!.id?scope:old??scope);
    return claimed?.id===scope.id;
}
export async function releaseDeliveryTarget(ports:Ports,scope:DeliveryScope) {
    if(scope.target)await ports.journal.update<DeliveryScope|null>(key(scope.target),old=>old?.id===scope.id?null:old??null);
}
async function releasable(ports:Ports,scope:DeliveryScope):Promise<boolean> {
    const state=await ports.journal.get<{done?:boolean}>('automatic-delivery:'+JSON.stringify([scope.boardId,scope.itemId]));
    if(state?.done)return true;
    let stopped=false;
    try{const detail=await ports.service.item(scope.boardId,scope.itemId);stopped=!!detail.archive||detail.item.deletedAt!==undefined||detail.item.status==='cancelled';}
    catch(error){if(!['BOARD_NOT_FOUND','ITEM_NOT_FOUND'].includes((error as {code:string}).code))throw error;stopped=true;}
    if(!stopped)return false;
    const settings=await ports.journal.get<ReviewSettings>(reviewKey(scope.boardId,scope.itemId));
    const jobs=await ports.journal.getMany<ReviewJob>((settings?.jobs??[]).map(jobKey));
    return jobs.every(job=>job?.phase==='settled');
}

import {currentDeliveryRecord} from './kanban-delivery-options';
import {t} from '@nestos/common';
import {selectedDeliveryProfile,deliveryProfile,type DeliveryProfile as Profile} from '@nestos/git-delivery/policy';
import {savedManagementScopes} from './kanban-management-scope-catalog';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DeliveryPlan,ReviewJob,ReviewSettings} from '@nestos/kanban-development';
import {jobKey,reviewKey} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
export function developmentDeliveryPlan(journal:KanbanAutomationJournal,service:Pick<import('@nestos/kanban/contracts').KanbanService,'workflow'|'record'>) {
    return async(board:KanbanBoard,item:KanbanItem):Promise<DeliveryPlan>=>{
        const dispatch=Object.values((await service.workflow(board.id)).dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        const saved=dispatch?await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id):undefined;
        const record=saved?await currentDeliveryRecord(service,saved):undefined;
        const frozen=(record?.context as {delivery?:Profile}|undefined)?.delivery;
        const updated=(record?.context as {decision?:{snapshot?:{deliveryOptions?:unknown}}})?.decision?.snapshot?.deliveryOptions;
        if(updated&&record){const selected=selectedDeliveryProfile(record.policy,item,record.context);if(selected)return selected;}
        return frozen?{...frozen,...(frozen.id==='source'?{acceptanceLabel:t('kanban.operationAcceptSource'),acceptanceConfirmation:t('kanban.operationConfirmSource')}:{})}:record&&deliveryProfile(record.policy,item)||{steps:['build','deploy','accept','analyze','merge','cleanup'],acceptance:'runtime'};
    };
}
/** Only a confirmed deployment receipt may become the independent verifier's input. */
export async function deliveryEvidence(journal:KanbanAutomationJournal,context:unknown) {
    const snapshot=(context as {decision?:{snapshot?:{deliveryMode?:string;deliveryOptions?:{deliveryMode?:string}}}})?.decision?.snapshot;
    const action=(snapshot?.deliveryOptions??snapshot)?.deliveryMode==='source'?'merge':'deploy';
    const value=context as {board?:{id:string};task?:{dependencies:string[];parentId?:string}},evidence=[];
    for(const item of value.task?.dependencies??[]){
        const scopes=value.task?.parentId?await savedManagementScopes(journal,value.board!.id,value.task.parentId):[];
        const keys=[reviewKey(value.board!.id,item),...scopes.filter(scope=>scope.contributors.some(source=>source.itemId===item)).map(scope=>reviewKey(value.board!.id,scope.ownerId,scope.id))];
        const settings=await journal.getMany<ReviewSettings>(keys);
        for(const id of [...new Set(settings.flatMap(setting=>setting?.jobs??[]))]){const job=await journal.get<ReviewJob>(jobKey(id));if(job?.action===action&&job.state==='succeeded'&&job.phase==='settled')evidence.push({itemId:item,operationId:job.id,action:job.action,result:job.result});}
    }
    requireValue(evidence.length===1,'VERIFICATION_DEPLOYMENT_REQUIRED');return evidence[0];
}

import {t} from '@nestos/common';
import {deliveryProfile,type DeliveryProfile as Profile} from '@nestos/git-delivery/policy';
import {savedManagementScopes} from './kanban-management-scope-catalog';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DeliveryPlan,ReviewJob,ReviewSettings} from '../kanban/item-operation-types';
import {jobKey,reviewKey} from '../kanban/item-operation-types';
import {requireValue} from '../kanban/validation';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
export function developmentDeliveryPlan(journal:KanbanAutomationJournal,service:{workflow(board:string):Promise<import('@nestos/kanban/contracts').KanbanWorkflowState>}) {
    return async(board:KanbanBoard,item:KanbanItem):Promise<DeliveryPlan>=>{
        const dispatch=Object.values((await service.workflow(board.id)).dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        const record=dispatch?await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+dispatch.id):undefined;
        const frozen=(record?.context as {delivery?:Profile}|undefined)?.delivery;
        return frozen?{...frozen,...(frozen.id==='source'?{acceptanceLabel:t('kanban.operationAcceptSource'),acceptanceConfirmation:t('kanban.operationConfirmSource')}:{})}:record&&deliveryProfile(record.policy,item)||{steps:['build','deploy','accept','analyze','merge','cleanup'],acceptance:'runtime'};
    };
}
/** Only a confirmed deployment receipt may become the independent verifier's input. */
export async function deliveryEvidence(journal:KanbanAutomationJournal,context:unknown) {
    const value=context as {board?:{id:string};task?:{dependencies:string[];parentId?:string}},evidence=[];
    for(const item of value.task?.dependencies??[]){
        const scopes=value.task?.parentId?await savedManagementScopes(journal,value.board!.id,value.task.parentId):[];
        const keys=[reviewKey(value.board!.id,item),...scopes.filter(scope=>scope.contributors.some(source=>source.itemId===item)).map(scope=>reviewKey(value.board!.id,scope.ownerId,scope.id))];
        const settings=await journal.getMany<ReviewSettings>(keys);
        for(const id of [...new Set(settings.flatMap(setting=>setting?.jobs??[]))]){const job=await journal.get<ReviewJob>(jobKey(id));if(job?.action===((context as {decision?:{snapshot?:{deliveryMode?:string}}})?.decision?.snapshot?.deliveryMode==='source'?'merge':'deploy')&&job.state==='succeeded'&&job.phase==='settled')evidence.push({itemId:item,operationId:job.id,action:job.action,result:job.result});}
    }
    requireValue(evidence.length===1,'VERIFICATION_DEPLOYMENT_REQUIRED');return evidence[0];
}

import {journalCommand,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService} from '@nestos/kanban/contracts';
interface DeliveryFailure {code:string;generation?:number;settled?:boolean;issues?:Array<{id:string;code:string}>}
interface Scope {boardId:string;itemId:string;attemptId:string}
/** A verified host handoff closes only the delivery issues that the host itself registered. */
export async function recordDeliveryFailure(journal:KanbanAutomationJournal,attemptId:string,code:string):Promise<string> {
    const value=await journal.update<DeliveryFailure>('delivery-blocked:'+attemptId,old=>{
        const generation=(old?.generation??0)+(old?.settled?1:0);
        const issues=old&&!old.settled?[...old.issues??[{id:'delivery-'+old.code,code:old.code}]]:[];
        const id='delivery-'+code+(generation?'-'+generation:'');
        if(!issues.some(issue=>issue.id===id))issues.push({id,code});
        return {code,generation,issues};
    });
    return value.issues!.find(issue=>issue.code===code)!.id;
}
export async function resolveDeliveryFailures(journal:KanbanAutomationJournal,service:KanbanService,scope:Scope):Promise<string|undefined> {
    const key='delivery-blocked:'+scope.attemptId,record=await journal.get<DeliveryFailure>(key);
    if(!record)return;
    if(record.settled)return String(record.generation??0);
    const {item}=await service.item(scope.boardId,scope.itemId);
    for(const issue of record.issues??[{id:'delivery-'+record.code,code:record.code}]) {
        if(!item.issues?.some(row=>row.id===issue.id&&row.attemptId===scope.attemptId&&!row.resolvedBy))continue;
        await journalCommand(journal,service,scope.boardId,'delivery-verified:'+scope.attemptId+':'+issue.id,
            {type:'resolve-issue',itemId:scope.itemId,attemptId:scope.attemptId,issueId:issue.id,resolvedBy:'verified-'+issue.id});
    }
    const settled=await journal.update<DeliveryFailure>(key,old=>old&&old.generation===record.generation?{...old,settled:true}:old??record);
    return settled.settled?String(settled.generation??0):undefined;
}

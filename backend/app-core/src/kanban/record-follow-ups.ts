import {developmentDeliveryPolicy} from '@nestos/kanban-development';
import type {KanbanItemSummary,KanbanRecordPage,KanbanTaskProjection} from '@nestos/kanban/contracts';
import {deliveryStatus,recordFinalization,safeCode,type AutomaticDeliveryState,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {randomUUID} from '@nestos/common';
import {automaticDeliveryStatuses} from '@nestos/kanban/integration';

/** Finalization facts supplement completion; they never reopen a settled task group. */
const awaitingFinalization=(progress:import('@nestos/kanban/contracts').KanbanRecordProgress|undefined)=>
    progress?.state==='completed'||progress?.reason==='GROUP_SETTLEMENT_PENDING';

export async function recordFollowUps(journal:KanbanAutomationJournal,board:string,page:KanbanRecordPage,status?:(board:string,item:string)=>Promise<import('@nestos/kanban/contracts').KanbanItemOperations['automatic']>):Promise<KanbanRecordPage> {
    const targets=page.items.flatMap(record=>awaitingFinalization(record.progress)?(record.progress!.groupIds??[]).map(itemId=>({boardId:record.progress!.boardId??board,itemId})):[]);
    if(!targets.length)return page;
    const started=Date.now(),operationId=randomUUID();
    let statuses:Awaited<ReturnType<typeof automaticDeliveryStatuses>>,readFailed=false;
    try {
        statuses=status?await Promise.all(targets.map(target=>status(target.boardId,target.itemId))):await automaticDeliveryStatuses(journal,targets,developmentDeliveryPolicy.steps);
        journal.diagnostic({operationId,boardId:board,stage:'record.follow-ups.read',result:'success',count:targets.length,durationMs:Date.now()-started});
    }catch(error){readFailed=true;const code=safeCode(error,'RECORD_FOLLOW_UPS_FAILED');journal.diagnostic({operationId,boardId:board,stage:'record.follow-ups.read',result:'failure',code,durationMs:Date.now()-started});statuses=targets.map(()=>({state:'blocked',stage:'unknown',code}));}
    return {...page,items:page.items.map(record=>{
            const progress=record.progress;
            if(!progress||!awaitingFinalization(progress))return record;
            const groups=new Set(progress.groupIds??[]);
            const followUps=targets.flatMap((target,index)=>{
                const status=statuses[index];
                if(target.boardId!==(record.progress!.boardId??board)||!groups.has(target.itemId)||!status||status.state==='completed')return [];
                return [{...target,state:readFailed?'unknown' as const:status.state==='blocked'?'blocked' as const:'pending' as const,phase:status.stage,
                    ...(status.state==='waiting-confirmation'?{requiresConfirmation:true}:{}),...(status.code?{code:status.code}:{})}];
            });
            if(progress.reason==='GROUP_SETTLEMENT_PENDING'&&!followUps.some(row=>row.phase!=='cleanup'&&(row.state!=='pending'||row.requiresConfirmation)))return record;
            return {...record,progress:recordFinalization(progress,followUps)};
        })};
}

export async function projectManagementFinalization(
    boardId:string,itemId:string,task:import('@nestos/kanban/contracts').KanbanTaskProjection,
    read?: (board:string,item:string)=>Promise<import('@nestos/kanban/contracts').KanbanItemOperations['automatic']>,
):Promise<import('@nestos/kanban/contracts').KanbanTaskProjection> {
    if(!read||task.reason!=='GROUP_SETTLEMENT_PENDING')return task;
    const status=await read(boardId,itemId);
    if(!status||status.stage==='cleanup')return task;
    if(status.state==='blocked')return {...task,phase:'error',reason:status.code??'DELIVERY_BLOCKED'};
    if(status.state==='waiting-confirmation')return {...task,phase:'waiting-input',reason:'DELIVERY_CONFIRMATION_REQUIRED'};
    return task;
}

/** Use the persisted delivery journal for board placement without opening workspaces or Sessions. */
export async function projectClosedDevelopmentGroups(journal:KanbanAutomationJournal,boardId:string,items:readonly KanbanItemSummary[]) {
    const ids=new Set(items.filter(item=>item.externalRefs?.some(ref=>ref.system==='nestos-software-reports')).map(item=>item.id));
    const result=new Map<string,Pick<KanbanTaskProjection,'phase'|'reason'>>();
    if(!ids.size)return result;
    const keys=ids.size===1?[boardId,[...ids][0]]:[boardId];
    const prefix='automatic-delivery:'+JSON.stringify(keys).slice(0,-1)+(ids.size===1?'':',');
    const saved=await readDevelopmentDelivery(journal,boardId,prefix,ids);
    if(!saved)return new Map([...ids].map(id=>[id,{phase:'unknown' as const,reason:'DELIVERY_STATUS_UNCONFIRMED'}]));
    const states=new Map<string,AutomaticDeliveryState[]>();
    for(const {value} of saved){
        const rows=states.get(value.itemId)??[];
        rows.push(value);states.set(value.itemId,rows);
    }
    for(const id of ids){
        const rows=states.get(id)??[],scopes=rows.filter(row=>row.scopeId);
        const delivery=developmentDeliveryPhase(scopes.length?scopes:rows);
        if(delivery)result.set(id,delivery);
    }
    return result;
}

async function readDevelopmentDelivery(journal:KanbanAutomationJournal,boardId:string,prefix:string,ids:Set<string>) {
    const started=Date.now(),operationId=randomUUID(),stage='closed-groups.delivery.read';
    try {
        const rows=await journal.find<AutomaticDeliveryState>(prefix,value=>value.boardId===boardId&&ids.has(value.itemId));
        journal.diagnostic({operationId,boardId,stage,result:'success',count:rows.length,durationMs:Date.now()-started});
        return rows;
    } catch(error) {
        const code=safeCode(error,'DELIVERY_STATUS_UNCONFIRMED');
        journal.diagnostic({operationId,boardId,stage,result:'failure',code,durationMs:Date.now()-started});
    }
}

function developmentDeliveryPhase(rows:AutomaticDeliveryState[]):Pick<KanbanTaskProjection,'phase'|'reason'>|undefined {
    if(!rows.length)return {phase:'waiting-dependency',reason:'DELIVERY_PENDING'};
    const pending=rows.map(row=>deliveryStatus({...row,steps:row.steps??developmentDeliveryPolicy.steps}))
        .filter(row=>row.state!=='completed'&&row.stage!=='cleanup');
    const blocked=pending.find(row=>row.state==='blocked');
    if(blocked)return {phase:'error',reason:blocked.code??'DELIVERY_BLOCKED'};
    if(pending.some(row=>row.state==='waiting-confirmation'))return {phase:'waiting-input',reason:'DELIVERY_CONFIRMATION_REQUIRED'};
    if(pending.some(row=>row.waitingForTarget))return {phase:'waiting-dependency',reason:'DELIVERY_WAITING_FOR_TARGET'};
    if(pending.length)return {phase:'running',reason:'DELIVERY_IN_PROGRESS'};
}

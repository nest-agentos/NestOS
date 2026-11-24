import {developmentDeliveryPolicy} from '@nestos/kanban-development';
import type {KanbanRecordPage} from '@nestos/kanban/contracts';
import {recordFinalization,safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
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

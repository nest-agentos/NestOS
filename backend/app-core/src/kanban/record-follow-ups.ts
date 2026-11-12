import type {KanbanRecordPage} from '@nestos/kanban/contracts';
import {recordFinalization,safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {randomUUID} from '@nestos/common';
import {automaticDeliveryStatuses} from './automatic-delivery';

/** Finalization facts supplement completion; they never reopen a settled task group. */
export async function recordFollowUps(journal:KanbanAutomationJournal,board:string,page:KanbanRecordPage,status?:(board:string,item:string)=>Promise<import('@nestos/kanban/contracts').KanbanItemOperations['automatic']>):Promise<KanbanRecordPage> {
    const targets=page.items.flatMap(record=>record.progress?.state==='completed'?(record.progress.groupIds??[]).map(itemId=>({boardId:record.progress!.boardId??board,itemId})):[]);
    if(!targets.length)return page;
    const started=Date.now(),operationId=randomUUID();
    let statuses:Awaited<ReturnType<typeof automaticDeliveryStatuses>>,readFailed=false;
    try {
        statuses=status?await Promise.all(targets.map(target=>status(target.boardId,target.itemId))):await automaticDeliveryStatuses(journal,targets);
        journal.diagnostic({operationId,boardId:board,stage:'record.follow-ups.read',result:'success',count:targets.length,durationMs:Date.now()-started});
    }catch(error){readFailed=true;const code=safeCode(error,'RECORD_FOLLOW_UPS_FAILED');journal.diagnostic({operationId,boardId:board,stage:'record.follow-ups.read',result:'failure',code,durationMs:Date.now()-started});statuses=targets.map(()=>({state:'blocked',stage:'unknown',code}));}
    return {...page,items:page.items.map(record=>{
            if(record.progress?.state!=='completed')return record;
            const groups=new Set(record.progress.groupIds??[]);
            const followUps=targets.flatMap((target,index)=>{
                const status=statuses[index];
                if(target.boardId!==(record.progress!.boardId??board)||!groups.has(target.itemId)||!status||status.state==='completed')return [];
                return [{...target,state:readFailed?'unknown' as const:status.state==='blocked'?'blocked' as const:'pending' as const,phase:status.stage,
                    ...(status.state==='waiting-confirmation'?{requiresConfirmation:true}:{}),...(status.code?{code:status.code}:{})}];
            });
            return {...record,progress:recordFinalization(record.progress,followUps)};
        })};
}

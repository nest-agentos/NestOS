import {jobKey,reviewKey} from '@nestos/kanban/integration';
import type {ReviewJob,ReviewOperationsOptions,ReviewSettings} from './item-operation-types';
import {scopedOperationOptions} from './item-operation-scopes';
import {requireValue} from './validation';
type Scope={board:string;item:string;scopeId?:string};
const same=(a:Scope,b:Scope)=>a.board===b.board&&a.item===b.item&&a.scopeId===b.scopeId;
/** Retire only settled archive registrations; retain receipts and unresolved responsibilities. */
export async function scanArchivedScope(options:ReviewOperationsOptions,scope:Scope,observe:(options:ReviewOperationsOptions,job:ReviewJob)=>Promise<ReviewJob>):Promise<boolean> {
    const detail=await options.service.item(scope.board,scope.item);if(!detail.archive)return false;
    const started=Date.now(),settings=await options.journal.get<ReviewSettings>(reviewKey(scope.board,scope.item,scope.scopeId));
    const jobs=await options.journal.getMany<ReviewJob>((settings?.jobs??[]).map(jobKey));
    for(const job of jobs)requireValue(!job||job.boardId===scope.board&&job.itemId===scope.item&&job.scopeId===scope.scopeId,'OPERATION_SCOPE_MISMATCH');
    const pending=jobs.filter(job=>job?.phase!=='settled');
    if(pending.some(job=>job?.phase==='submitting'&&job.action!=='accept')){
        const scoped=await scopedOperationOptions(options,scope.board,scope.item,scope.scopeId);
        const observing={...scoped,adapter:{...scoped.adapter,exchange:undefined}};
        for(const job of pending)if(job?.phase==='submitting'&&job.action!=='accept')jobs[jobs.indexOf(job)]=await observe(observing,job);
    }
    const unresolved=jobs.filter(job=>job?.phase!=='settled');
    if(unresolved.length){
        options.log({operationId:scope.scopeId??scope.item,boardId:scope.board,itemId:scope.item,stage:'operation.scope.archived-pending',result:'failure',
            code:unresolved.some(job=>!job)?'ARCHIVED_OPERATION_RECORD_MISSING':'ARCHIVED_OPERATION_UNSETTLED',count:unresolved.length,durationMs:Date.now()-started});
        return true;
    }
    await options.journal.update<Scope[]>('review-operation-scopes',old=>(old??[]).filter(row=>!same(row,scope)));
    options.log({operationId:scope.scopeId??scope.item,boardId:scope.board,itemId:scope.item,stage:'operation.scope.archived',result:'success',count:jobs.length,durationMs:Date.now()-started});
    return true;
}

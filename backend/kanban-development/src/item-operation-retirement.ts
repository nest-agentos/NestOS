import {jobKey,reviewKey} from '@nestos/kanban/integration';
import type {ReviewJob,ReviewOperationsOptions,ReviewSettings} from './item-operation-types';
import {scopedOperationOptions} from './item-operation-scopes';
import {requireValue} from './validation';
type Scope={board:string;item:string;scopeId?:string};
const same=(a:Scope,b:Scope)=>a.board===b.board&&a.item===b.item&&a.scopeId===b.scopeId;
/** Retire only settled inactive registrations; retain receipts and unresolved responsibilities. */
export async function scanRetiredScope(options:ReviewOperationsOptions,scope:Scope,observe:(options:ReviewOperationsOptions,job:ReviewJob)=>Promise<ReviewJob>):Promise<boolean> {
    const detail=await options.service.item(scope.board,scope.item);if(!detail.archive&&detail.item.status!=='cancelled'&&detail.item.deletedAt===undefined)return false;
    const reason=detail.archive?'archived':detail.item.deletedAt!==undefined?'deleted':'cancelled';
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
        options.log({operationId:scope.scopeId??scope.item,boardId:scope.board,itemId:scope.item,stage:'operation.scope.inactive-pending',result:'failure',
            code:unresolved.some(job=>!job)?'INACTIVE_OPERATION_RECORD_MISSING':'INACTIVE_OPERATION_UNSETTLED',reason,count:unresolved.length,durationMs:Date.now()-started});
        return true;
    }
    await options.journal.update<Scope[]>('review-operation-scopes',old=>(old??[]).filter(row=>!same(row,scope)));
    options.log({operationId:scope.scopeId??scope.item,boardId:scope.board,itemId:scope.item,stage:'operation.scope.retired',result:'success',reason,count:jobs.length,durationMs:Date.now()-started});
    return true;
}

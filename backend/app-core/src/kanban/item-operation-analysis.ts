import {reviewKey,type ReviewOperationsOptions,type ReviewSettings} from './item-operation-types';
/** Keep the successful analysis as history while revoking its eligibility for a new merge. */
export async function invalidateReviewAnalysis(options:ReviewOperationsOptions,board:string,item:string,id:string,code:string,operationId:string):Promise<void> {
    const started=Date.now();
    await options.journal.update<ReviewSettings>(reviewKey(board,item,options.scopeId),old=>{
        if(!old||old.invalidatedAnalysis?.id===id&&old.invalidatedAnalysis.code===code)return old!;
        return {...old,revision:old.revision+1,invalidatedAnalysis:{id,code}};
    });
    options.log({operationId,stage:'operation.merge.revalidate',result:'failure',code,durationMs:Date.now()-started});
}

/** Recheck at external admission as well as when the confirmation request was prepared. */
export async function revalidateMergeAdmission(options:ReviewOperationsOptions,job:import('./item-operation-types').ReviewJob):Promise<void> {
    if(job.action!=='merge')return;
    const board=await options.service.read(job.boardId),{item}=await options.service.item(job.boardId,job.itemId);
    const actual=await options.adapter.snapshot(board,item);if(actual.version===job.snapshot.version)return;
    const code=actual.sourceVersion!==job.snapshot.sourceVersion?'OPERATION_SOURCE_CHANGED_REANALYZE':'OPERATION_TARGET_CHANGED_REANALYZE';
    const analysisId=(job.operationContext as {analysisId?:string})?.analysisId;
    if(analysisId)await invalidateReviewAnalysis(options,job.boardId,job.itemId,analysisId,code,job.id);
    throw Object.assign(new Error(code),{code,executionOutcome:'not-started',retryable:false});
}

import {sha256HexSync} from '@nestos/common';
import {reviewCleanupKey,type ReviewCleanup,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import prompt from './prompts/cleanup-review.json';
export type CleanupReviewInput=ReviewCleanup&{boardId:string;itemId:string;scopeId?:string};
export const cleanupReviewId=(input:CleanupReviewInput)=>'cleanup-review-'+sha256HexSync(JSON.stringify([input.boardId,input.itemId,input.scopeId,input.runId,input.operationId])).slice(0,48);
export function cleanupReviewInstruction(reviewId:string,legacyContext?:unknown):string {
 return legacyContext===undefined?prompt.reviewInstruction+'\nreviewId: '+reviewId
    :prompt.instruction+'\nAuthorized cleanup context:\n'+JSON.stringify(legacyContext);
}
/** A model attempt permits one new host inspection, never a model-authored success result. */
export async function finishCleanupReview(journal:KanbanAutomationJournal,input:CleanupReviewInput):Promise<void>{
 const key=reviewCleanupKey(input.boardId,input.itemId,input.scopeId);
 await journal.update<ReviewCleanup>(key,old=>{if(!old||![old.operationId,old.reviewOperationId].includes(input.operationId)||old.runId!==input.runId)throw Object.assign(Error('Cleanup review changed'),{code:'CLEANUP_REVIEW_CHANGED'});return old.state==='succeeded'?old:{...old,reviewState:'reviewed',state:'running',code:undefined,retryAt:undefined};});
}

export function cleanupReviewStatus(cleanup:ReviewCleanup|undefined):import('@nestos/kanban/contracts').KanbanItemOperations['automatic'] {
 if(!cleanup||cleanup.state==='succeeded')return;
 return {state:cleanup.state==='failed'?'blocked':'running',stage:'cleanup',code:cleanup.code};
}

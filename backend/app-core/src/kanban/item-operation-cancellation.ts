import {sha256HexSync} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
import type {KanbanItemOperationRequest} from '@nestos/kanban/contracts';
import type {ReviewJob,ReviewOperationsOptions} from './item-operation-types';
import {jobKey} from './item-operation-types';
import {requireValue} from './validation';
export interface ReviewCancellation {history?:Array<{id:string;state:string;code?:string;requestedAt:number;actor?:import('@nestos/kanban/contracts').KanbanActor}>;actor?:import('@nestos/kanban/contracts').KanbanActor;previousState?:string;previousCode?:string;id:string;runId:string;boardId:string;itemId:string;fingerprint:string;requestedAt:number;state:'requested'|'accepted'|'unknown'|'cancelled'|'failed'|'not-required';code?:string}
export const cancellationKey=(id:string)=>'review-operation-cancel:'+id;
const indexKey='review-operation-cancellations';
export const pendingCancellation=(value:ReviewCancellation|undefined)=>!!value&&['requested','accepted','unknown'].includes(value.state);
export const blocksOperation=(value:ReviewCancellation|undefined)=>!!value&&!['failed','not-required'].includes(value.state);
export function cancellationSupported(options:ReviewOperationsOptions,job:ReviewJob):boolean {return !job.managed&&job.action!=='accept'&&!!(job.request?options.adapter.cancel:options.cancelOperation);}
export async function requestCancellation(options:ReviewOperationsOptions,board:string,request:KanbanItemOperationRequest,job:ReviewJob):Promise<void> {
    requireValue(request.confirmed===true&&request.cancel?.runId===job.id,'OPERATION_CONFIRMATION_REQUIRED');
    const actor=await options.service.currentPrincipal();
    const fingerprint=sha256HexSync(JSON.stringify([board,request.itemId,request.operationId,job.id,request.confirmed])),key=cancellationKey(job.id);
    const previous=await options.journal.get<ReviewCancellation>(key);requireValue(!previous||previous.fingerprint===fingerprint||previous.state==='failed','IDEMPOTENCY_CONFLICT');
    requireValue(!previous||previous.id===request.operationId||(previous.history?.length??0)<16,'OPERATION_HISTORY_LIMIT');
    if(previous&&['cancelled','not-required'].includes(previous.state))return;
    requireValue(cancellationSupported(options,job),'OPERATION_CANCEL_UNSUPPORTED');
    await options.journal.update<Array<{id:string;board:string;item:string}>>(indexKey,old=>old?.some(row=>row.id===job.id)?old:[...old??[],{id:job.id,board,item:job.itemId}]);
    const saved=await options.journal.update<ReviewCancellation>(key,old=>{
        requireValue(!old||old.fingerprint===fingerprint||old.state==='failed','IDEMPOTENCY_CONFLICT');
        if(old&&old.state!=='failed')return old;
        if(old?.id===request.operationId)return {...old,state:'requested',code:undefined};
        return {actor,previousState:job.state,previousCode:job.code,id:request.operationId,runId:job.id,boardId:board,itemId:job.itemId,fingerprint,requestedAt:Date.now(),state:'requested',
            ...(old?{history:[...old.history??[],{id:old.id,state:old.state,code:old.code,requestedAt:old.requestedAt,actor:old.actor}]}:{})};
    });
    if(!pendingCancellation(saved)){await removeIndex(options,job.id);return;}
    await reconcileCancellation(options,job.id);
}
export async function reconcileCancellation(options:ReviewOperationsOptions,id:string):Promise<void> {
    const key=cancellationKey(id),intent=await options.journal.get<ReviewCancellation>(key);if(!intent||!pendingCancellation(intent)){await removeIndex(options,id);return;}
    const job=await options.journal.get<ReviewJob>(jobKey(id));requireValue(job&&job.boardId===intent.boardId&&job.itemId===intent.itemId,'OPERATION_SCOPE_MISMATCH');
    const started=Date.now();
    try {
        const state=await stopReviewJob(options,job,intent.id);
        await update(options,intent,state,state==='not-required'?'OPERATION_ALREADY_SETTLED':undefined);
        if(state==='cancelled'){const latest=await options.journal.get<ReviewJob>(jobKey(id));if(latest)await options.report?.({...latest,code:'OPERATION_CANCELLED'});}
        options.log({operationId:intent.id,stage:'operation.cancel.reconcile',result:'success',durationMs:Date.now()-started});
    } catch(error){const code=safeCode(error,'OPERATION_CANCEL_UNKNOWN');await update(options,intent,(error as {cancelRejected?:boolean}).cancelRejected?'failed':'unknown',code);options.log({operationId:intent.id,stage:'operation.cancel.reconcile',result:'failure',code,durationMs:Date.now()-started});}
}
async function update(options:ReviewOperationsOptions,intent:ReviewCancellation,state:ReviewCancellation['state'],code?:string):Promise<void> {
    const saved=await options.journal.update<ReviewCancellation>(cancellationKey(intent.runId),old=>old&&(old.id!==intent.id||!pendingCancellation(old))?old:{...old!,state,code});
    if(!pendingCancellation(saved))await removeIndex(options,intent.runId);
}
export async function scanCancellations(options:ReviewOperationsOptions,active:()=>boolean):Promise<void> {
    for(const row of await options.journal.get<Array<{id:string}>>(indexKey)??[]){if(!active())return;try{await reconcileCancellation(options,row.id);}catch(error){options.log({operationId:row.id,stage:'operation.cancel.scan',result:'failure',code:safeCode(error,'OPERATION_CANCEL_UNKNOWN'),durationMs:0});}}
}

async function removeIndex(options:ReviewOperationsOptions,id:string):Promise<void> {
    await options.journal.update<Array<{id:string;board:string;item:string}>>(indexKey,old=>old?.filter(row=>row.id!==id)??[]);
}

async function stopReviewJob(options:ReviewOperationsOptions,job:ReviewJob,operationId:string):Promise<ReviewCancellation['state']> {
    const current=await options.journal.update<ReviewJob>(jobKey(job.id),value=>value?.phase==='prepared'?{...value,phase:'settled',state:'failed',code:'OPERATION_CANCELLED'}:value!);
    if(current.phase==='settled'&&current.state==='succeeded')return 'not-required';
    if(current.phase==='settled'&&current.code==='OPERATION_CANCELLED')return 'cancelled';
    const control=job.request?options.adapter.cancel:options.cancelOperation;requireValue(control,'OPERATION_CANCEL_UNSUPPORTED');
    const state=await control(job,operationId);
    if(state!=='cancelled')return state;
    const saved=await options.journal.update<ReviewJob>(jobKey(job.id),value=>value?.phase==='settled'?value:{...value!,phase:'settled',state:'failed',code:'OPERATION_CANCELLED'});
    return saved.state==='succeeded'?'not-required':'cancelled';
}

import {sha256HexSync} from '@nestos/common';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import type {ReviewAdapter,ReviewJob} from '../kanban/item-operation-types';
import type {submissionControl,SubmissionControlState} from '../run/submission-control';
import {requireValue} from '../kanban/validation';
interface Options {journal:KanbanAutomationJournal;submission:ReturnType<typeof submissionControl>;native(input:{scopeId:string;operationId:string;action:'cancel'}):Promise<SubmissionControlState>}
/** Freeze every admitted continuation and control only this review's channel. */
export function reviewCancellation(options:Options):NonNullable<ReviewAdapter['cancel']> {
    return async(job:ReviewJob,operationId:string)=>{
        requireValue(job.request?.expectedSessionId&&job.request.submission?.id,'OPERATION_CANCEL_UNSUPPORTED');
        const exchange=await options.journal.get<{request?:SubmissionRequest}>('channel-exchange:'+job.id);
        const requests=await options.journal.update<SubmissionRequest[]>('review-cancel-rounds:'+operationId,old=>old??[job.request!,...(exchange?.request&&exchange.request.submission?.id!==job.request!.submission!.id?[exchange.request]:[])]);
        const states:SubmissionControlState[]=[];
        try {
        for(const request of requests)states.push(await options.submission({sessionId:request.expectedSessionId!,submissionId:request.submission!.id,
            requestId:'review-cancel-'+sha256HexSync(JSON.stringify([job.id,operationId,request.submission!.id])),action:'cancel'},options.journal));
        const native=await options.native({scopeId:job.id,operationId:'review-native-'+sha256HexSync(JSON.stringify([job.id,operationId])),action:'cancel'});
        return states.every(state=>state==='cancelled')&&native==='cancelled'?'cancelled':states.includes('unknown')||native==='unknown'?'unknown':'accepted';
        } catch(error){if(error&&typeof error==='object')Object.assign(error,{cancelRejected:false});throw error;}
    };
}

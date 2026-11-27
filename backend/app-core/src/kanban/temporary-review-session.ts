import type {ReviewJob} from '@nestos/kanban-development';
import type {OperationObservation} from '@nestos/llm-session';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import {safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';

type Log = (event:{operationId:string;boardId:string;itemId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number})=>void;
interface Options {
    journal:KanbanAutomationJournal;
    inspect(input:IndependentCallInput):Promise<OperationObservation>;
    archive(sessionId:string,operationId:string):Promise<void>;
    log:Log;
}
interface ArchiveReceipt {sessionId?:string;retryAt?:number}

/** A dedicated publication owns its child. Continuations in a retained Session do not. */
export function archiveTemporaryReviewSession(options:Options) {
    return async (job:ReviewJob):Promise<void> => {
        const input=temporaryInput(job);
        if(!input)return;
        const operationId='review-session-archive:'+job.id,started=Date.now();
        const log=(result:'success'|'failure',code?:string)=>options.log({operationId,boardId:job.boardId,itemId:job.itemId,
            stage:'review.session.archive',result,code,durationMs:Date.now()-started});
        try {
            const saved=await options.journal.get<ArchiveReceipt>(operationId);
            if(saved?.sessionId||(saved?.retryAt??0)>started)return;
            const observed=await options.inspect(input);
            if(!['succeeded','failed'].includes(observed.state)||!observed.sessionId)throw failure('SESSION_ARCHIVE_EXECUTION_UNSETTLED');
            if(observed.sessionId!==job.sessionId||observed.sessionId===job.id)throw failure('SESSION_ARCHIVE_BINDING_CHANGED');
            await options.archive(observed.sessionId,operationId);
            await options.journal.update<ArchiveReceipt>(operationId,()=>({sessionId:observed.sessionId}));
            log('success');
        }catch(error){
            const code=safeCode(error,'SESSION_ARCHIVE_FAILED');
            log('failure',code);
            await options.journal.update<ArchiveReceipt>(operationId,old=>old?.sessionId?old:{retryAt:Date.now()+60_000});
        }
    };
}

function temporaryInput(job:ReviewJob):IndependentCallInput|undefined {
    if(job.phase!=='settled'||!['succeeded','failed'].includes(job.state)||job.request||job.managed||!job.sessionId)return;
    const request=job.input?.request;
    const submission=request?.submission,source=submission?.source;
    if(request?.expectedSessionId===job.id&&submission?.id===job.id&&source?.kind==='conversation'
        &&source.ownerId===job.id&&source.id===job.id)return job.input;
}
function failure(code:string):Error {return Object.assign(Error(code),{code});}

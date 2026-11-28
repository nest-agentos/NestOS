import {jobKey,releaseJournalResource,reserveJournalResource} from '@nestos/kanban/integration';
import type {ReviewJob,ReviewOperationsOptions} from './item-operation-types';

export const waitingIntegrationTarget='OPERATION_WAITING_INTEGRATION_TARGET';
interface Reservation {id:string;fingerprint:string}
const same=(left:Reservation,right:Reservation)=>left.fingerprint===right.fingerprint;

export async function claimIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<boolean> {
    if(!job.integrationTarget)return true;
    const started=Date.now(),owner={id:job.id,fingerprint:job.fingerprint};
    const claimed=await reserveJournalResource(options.journal,job.integrationTarget,owner,async previous=>{
        const saved=await options.journal.get<ReviewJob>(jobKey(previous.id));
        return saved?.fingerprint===previous.fingerprint&&saved.integrationTarget===job.integrationTarget&&saved.phase==='settled';
    },same);
    if(job.code!==waitingIntegrationTarget||claimed)options.log({operationId:job.id,boardId:job.boardId,itemId:job.itemId,
        stage:'integration.target.claim',result:'success',reason:claimed?'admitted':'queued',durationMs:Date.now()-started});
    return claimed;
}

export async function releaseIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<void> {
    if(job.integrationTarget&&job.phase==='settled')
        await releaseJournalResource(options.journal,job.integrationTarget,{id:job.id,fingerprint:job.fingerprint},same);
}

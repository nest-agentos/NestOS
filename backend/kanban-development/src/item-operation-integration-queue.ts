import {jobKey} from '@nestos/kanban/integration';
import type {ReviewJob,ReviewOperationsOptions} from './item-operation-types';
import {requireValue} from './validation';

export const waitingIntegrationTarget='OPERATION_WAITING_INTEGRATION_TARGET';
interface Entry {id:string;fingerprint:string}

export async function claimIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<boolean> {
    const target=job.integrationTarget;
    if(!target)return true;
    const started=Date.now(),entry={id:job.id,fingerprint:job.fingerprint};
    const saved=await options.journal.get<Entry[]>(target);
    const queue=saved?.some(row=>row.id===entry.id)?appendEntry(saved,entry):
        await options.journal.update<Entry[]>(target,old=>appendEntry(old??[],entry));
    const head=queue[0].id===job.id?queue[0]:await skipSettled(options,target,queue[0]);
    const claimed=head?.id===job.id;
    if(job.code!==waitingIntegrationTarget||claimed)options.log({operationId:job.id,boardId:job.boardId,itemId:job.itemId,
        stage:'integration.target.claim',result:'success',reason:claimed?'admitted':'queued',durationMs:Date.now()-started});
    return claimed;
}

function appendEntry(queue:Entry[],entry:Entry):Entry[] {
    const saved=queue.find(row=>row.id===entry.id);
    requireValue(!saved||saved.fingerprint===entry.fingerprint,'RESOURCE_RESERVATION_ID_CONFLICT');
    return saved?queue:[...queue,entry];
}

async function skipSettled(options:ReviewOperationsOptions,target:string,head:Entry):Promise<Entry|undefined> {
    const saved=await options.journal.get<ReviewJob>(jobKey(head.id));
    if(saved?.fingerprint!==head.fingerprint||saved.integrationTarget!==target||saved.phase!=='settled')return head;
    return (await options.journal.update<Entry[]>(target,old=>(old??[])
        .filter(row=>row.id!==head.id||row.fingerprint!==head.fingerprint)))[0];
}

export async function releaseIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<void> {
    if(job.integrationTarget&&job.phase==='settled'){
        await options.journal.update<Entry[]>(job.integrationTarget,old=>(old??[])
            .filter(row=>row.id!==job.id||row.fingerprint!==job.fingerprint));
    }
}

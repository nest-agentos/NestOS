import {jobKey} from '@nestos/kanban/integration';
import type {ReviewJob,ReviewOperationsOptions} from './item-operation-types';
import {requireValue} from './validation';

export const waitingIntegrationTarget='OPERATION_WAITING_INTEGRATION_TARGET';
interface Entry {id:string;fingerprint:string}

export async function claimIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<boolean> {
    const target=job.integrationTarget;
    if(!target)return true;
    const started=Date.now(),entry={id:job.id,fingerprint:job.fingerprint};
    const queue=await options.journal.update<Entry[]>(target,old=>{
        const saved=old?.find(row=>row.id===entry.id);
        requireValue(!saved||saved.fingerprint===entry.fingerprint,'RESOURCE_RESERVATION_ID_CONFLICT');
        return saved?old!:[...old??[],entry];
    });
    const head=queue[0].id===job.id?queue[0]:await skipSettled(options,target,queue);
    const claimed=head?.id===job.id;
    if(job.code!==waitingIntegrationTarget||claimed)options.log({operationId:job.id,boardId:job.boardId,itemId:job.itemId,
        stage:'integration.target.claim',result:'success',reason:claimed?'admitted':'queued',durationMs:Date.now()-started});
    return claimed;
}

async function skipSettled(options:ReviewOperationsOptions,target:string,queue:Entry[]):Promise<Entry|undefined> {
    const stored=await options.journal.getMany<ReviewJob>(queue.map(row=>jobKey(row.id)));
    const completed=new Map(queue.flatMap((row,index)=>{
        const saved=stored[index];
        return saved?.fingerprint===row.fingerprint&&saved.integrationTarget===target&&saved.phase==='settled'?[[row.id,row.fingerprint]]:[];
    }));
    if(!completed.size)return queue[0];
    return (await options.journal.update<Entry[]>(target,old=>(old??[]).filter(row=>completed.get(row.id)!==row.fingerprint)))[0];
}

export async function releaseIntegrationTarget(options:ReviewOperationsOptions,job:ReviewJob):Promise<void> {
    if(job.integrationTarget&&job.phase==='settled'){
        await options.journal.update<Entry[]>(job.integrationTarget,old=>(old??[])
            .filter(row=>row.id!==job.id||row.fingerprint!==job.fingerprint));
    }
}

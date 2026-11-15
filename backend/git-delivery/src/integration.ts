import type {GitProcess,GitIntegration} from './contracts';
import {gitWorkspace} from './worktree-modules';
import {requireValue} from './errors';
import {verifyManagementChanges} from './changes';
export {verifyManagementChanges} from './changes';
/** Verify every frozen contributor against actual Git objects, including locked gitlinks. */
export async function verifyGitIntegration(process:GitProcess,input:GitIntegration):Promise<void> {
    const {actualTarget:target}=input;requireValue(input.reportedTarget===target,'OPERATION_RESULT_MERGE_UNCONFIRMED');
    const ancestor=async(commit:string)=>(await gitWorkspace(process,'/workspace',['merge-base','--is-ancestor',commit,target],true)).code===0;
    requireValue(await ancestor(input.previousTarget),'OPERATION_RESULT_TARGET_REWRITTEN');
    for(const source of input.sources){
        requireValue(typeof source.sourceHead==='string'&&await ancestor(source.sourceHead),input.incompleteCode??'OPERATION_RESULT_BATCH_INCOMPLETE');
        for(const repository of source.repositories??[]){
            if(repository.path==='.'){if(repository.dirty)await verifyManagementChanges(process,input.approval,source.directory,target,'.',{target:input.previousTarget,base:source.sourceHead!,operationId:input.operationId});continue;}
            const entry=(await gitWorkspace(process,'/workspace',['ls-tree',target,'--',repository.path])).stdout;
            const head=/^160000 commit ([a-f0-9]{40,64})\t/.exec(entry)?.[1];requireValue(head,'OPERATION_RESULT_BATCH_INCOMPLETE');
            requireValue((await gitWorkspace(process,'/workspace/'+repository.path,['merge-base','--is-ancestor',repository.head,head],true)).code===0,'OPERATION_RESULT_BATCH_INCOMPLETE');
            if(repository.dirty){
                const previous=(await gitWorkspace(process,'/workspace',['ls-tree',input.previousTarget,'--',repository.path])).stdout;
                const before=/^160000 commit ([a-f0-9]{40,64})\t/.exec(previous)?.[1];
                await verifyManagementChanges(process,input.approval,source.directory,head,repository.path,before?{target:before,base:repository.head,operationId:input.operationId}:undefined);
            }
        }
    }
}

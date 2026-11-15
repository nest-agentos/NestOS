import {createModuleLogger,sha256HexSync} from '@nestos/common';
const log=createModuleLogger('git-delivery');
import type {GitProcess as RemoteProcessHandle,GitApproval} from './contracts';
import {gitWorkspace} from './worktree-modules';
import {processWorkspacePath} from './worktree-paths';
import {requireValue} from './errors';

/** Changes-only delivery keeps its original commit policy; verify approved file effects in Git. */
export async function verifyManagementChanges(process:RemoteProcessHandle,approval:GitApproval|undefined,sourceDirectory:string,target:string,modulePath:string,previous?:{target:string;base:string;operationId?:string}):Promise<void> {
    const source=modulePath==='.'?sourceDirectory:sourceDirectory+'/'+modulePath;
    const destination=modulePath==='.'?'/workspace':'/workspace/'+modulePath;
    const changed=(await gitWorkspace(process,source,['diff','--name-only','--no-renames','-z','HEAD','--'])).stdout;
    const untracked=(await gitWorkspace(process,source,['ls-files','--others','--exclude-standard','-z'])).stdout;
    const paths=[...new Set((changed+untracked).split('\0').filter(Boolean))];
    requireValue(paths.length<=1000,'DELIVERY_FILE_LIMIT');
    for(const path of paths){
        const full=modulePath==='.'?path:modulePath+'/'+path;
        if(approvedConflict(approval,full))continue;
        const entry=(await gitWorkspace(process,destination,['ls-tree',target,'--',path])).stdout;
        const deleted=(await gitWorkspace(process,source,['diff','--name-only','--diff-filter=D','-z','HEAD','--',path])).stdout.split('\0').includes(path);
        if(deleted){requireValue(!entry,'OPERATION_RESULT_BATCH_INCOMPLETE');continue;}
        if(entry.startsWith('160000 commit '))continue;
        const hash=(await gitWorkspace(process,source,['hash-object','--',path])).stdout.trim();
        requireValue(/^(100644|100755) blob /.test(entry),'OPERATION_RESULT_BATCH_INCOMPLETE');
        const actual=entry.split(/\s+/)[2];
        if(actual===hash)continue;
        requireValue(previous,'OPERATION_RESULT_BATCH_INCOMPLETE');
        const started=Date.now();
        try{await verifyMergedBlob(process,{source,destination,path,hash,actual,...previous});}
        catch(error){log.warn('Integrated source change could not be verified',{operationId:previous.operationId??'verify-'+sha256HexSync(source).slice(0,32),stage:'delivery.changes.verify',result:'failure',code:(error as {code?:string}).code??'GIT_MERGE_VERIFY_FAILED',repository:modulePath,pathHash:sha256HexSync(full).slice(0,16),sourceBlob:hash,targetBlob:actual,durationMs:Date.now()-started});throw error;}
    }
}
/** Compare the exact conflict-free merge result, preserving independent target edits without changing either index or HEAD. */
async function verifyMergedBlob(process:RemoteProcessHandle,input:{source:string;destination:string;path:string;hash:string;actual:string;target:string;base:string}):Promise<void> {
    const {source,destination,path,hash,actual,target,base}=input;
    const blob=async(commit:string)=>{const row=(await gitWorkspace(process,destination,['ls-tree',commit,'--',path])).stdout;return /^[0-9]{6} blob ([a-f0-9]{40,64})\t/.exec(row)?.[1];};
    const [original,ours]=await Promise.all([blob(base),blob(target)]);
    requireValue(original&&ours,'OPERATION_RESULT_BATCH_INCOMPLETE');
    const absolute=await processWorkspacePath(process,source+'/'+path);
    const stored=(await gitWorkspace(process,destination,['hash-object','-w','--path='+path,'--',absolute])).stdout.trim();
    requireValue(stored===hash,'OPERATION_SOURCE_FILTER_CHANGED');
    const merged=await gitWorkspace(process,destination,['merge-file','--object-id',ours,original,stored],true);
    requireValue(merged.code!==129,'GIT_OBJECT_MERGE_UNAVAILABLE');
    requireValue(merged.code===0&&merged.stdout.trim()===actual,'OPERATION_RESULT_BATCH_INCOMPLETE');
}
function approvedConflict(approval:GitApproval|undefined,path:string):boolean {
    return !!approval?.plan?.conflicts?.some(conflict=>conflict.path===path&&conflict.options.some(option=>option.id===approval.selections?.[conflict.id]));
}

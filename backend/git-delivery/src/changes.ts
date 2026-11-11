import type {GitProcess as RemoteProcessHandle,GitApproval} from './contracts';
import {gitWorkspace} from './worktree-modules';
import {requireValue} from './errors';

/** Changes-only delivery keeps its original commit policy; verify approved file effects in Git. */
export async function verifyManagementChanges(process:RemoteProcessHandle,approval:GitApproval|undefined,sourceDirectory:string,target:string,modulePath:string):Promise<void> {
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
        // Gitlinks are verified against the selected submodule repository by the caller.
        if(entry.startsWith('160000 commit '))continue;
        const hash=(await gitWorkspace(process,source,['hash-object','--',path])).stdout.trim();
        requireValue(/^(100644|100755) blob /.test(entry)&&entry.split(/\s+/)[2]===hash,'OPERATION_RESULT_BATCH_INCOMPLETE');
    }
}
function approvedConflict(approval:GitApproval|undefined,path:string):boolean {
    const input=approval;
    return !!input?.plan?.conflicts?.some(conflict=>conflict.path===path&&conflict.options.some(option=>option.id===input.selections?.[conflict.id]));
}

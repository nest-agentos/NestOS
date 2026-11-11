import {sha256HexSync} from '@nestos/common';
import {requireValue} from './errors';
import type {GitProcess as RemoteProcessHandle} from './contracts';
import {gitWorkspace,type WorktreeRepository} from './worktree-modules';
export interface ModuleProof {path:string;head:string;target:string;reasons:string[]}
/** Git requires force for populated submodules; prove every retained commit and file first. */
export async function inspectRemovalModules(process:RemoteProcessHandle,directory:string,authorized:WorktreeRepository[]) {
    const listing=(await gitWorkspace(process,directory,['submodule','status','--recursive'])).stdout;
    const modules:ModuleProof[]=[];
    for(const line of listing.split('\n').filter(line=>line&&!line.startsWith('-'))) {
        const path=line.slice(1).trim().split(' ')[1];
        requireValue(!!path&&path.split('/').every(part=>/^[\w.-]+$/.test(part)&&part!=='.'&&part!=='..'),'WORKTREE_MODULE_SCOPE_INVALID');
        requireValue(authorized.some(row=>row.path===path||row.path!=='.'&&path.startsWith(row.path+'/')),'WORKTREE_MODULE_SCOPE_INVALID');
        modules.push(await inspectModule(process,directory,path));
    }
    requireValue(modules.length>0,'WORKTREE_MODULE_INSPECTION_UNKNOWN');
    return {modules,reasons:[...new Set(modules.flatMap(row=>row.reasons))],version:sha256HexSync(JSON.stringify(modules))};
}
async function inspectModule(process:RemoteProcessHandle,directory:string,path:string):Promise<ModuleProof> {
    const source=directory+'/'+path,target='/workspace/'+path;
    const head=(await gitWorkspace(process,source,['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
    const targetHead=(await gitWorkspace(process,target,['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
    const changed=(await gitWorkspace(process,source,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'])).stdout;
    const ignored=(await gitWorkspace(process,source,['ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory','-z'])).stdout;
    const merged=await gitWorkspace(process,target,['merge-base','--is-ancestor',head,targetHead],true);
    requireValue(merged.code===0||merged.code===1,'WORKTREE_MODULE_INTEGRATION_UNKNOWN');
    return {path,head,target:targetHead,reasons:[changed&&'WORKTREE_DIRTY',ignored&&'WORKTREE_UNTRACKED_IGNORED',merged.code===1&&'WORKTREE_NOT_INTEGRATED'].filter((value):value is string=>!!value)};
}

/** Linked module worktrees share their source repository registry and must be unregistered explicitly. */
export async function removeLinkedModuleWorktrees(process:RemoteProcessHandle,directory:string,modules:ModuleProof[],branch:string):Promise<void>{
    for(const module of [...modules].sort((a,b)=>b.path.length-a.path.length)){
        const source='/workspace/'+module.path,child=directory+'/'+module.path;
        const listing=(await gitWorkspace(process,source,['worktree','list','--porcelain'])).stdout;
        const entry=listing.split('\n\n').find(row=>row.split('\n').includes('worktree '+child));
        if(!entry)continue;
        await gitWorkspace(process,source,['worktree','remove',child]);
        if(entry.split('\n').includes('branch refs/heads/'+branch))await gitWorkspace(process,source,['branch','-d',branch]);
    }
}

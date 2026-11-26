import {sha256HexSync} from '@nestos/common';
import {requireValue} from './errors';
import type {GitProcess as RemoteProcessHandle} from './contracts';
import {gitWorkspace,type WorktreeRepository} from './worktree-modules';
export interface ModuleProof {path:string;head:string;target:string;reasons:string[];ignoredPaths?:string[];retainedIgnored?:string[]}
/** Git requires force for populated submodules; prove every retained commit and file first. */
export async function inspectRemovalModules(process:RemoteProcessHandle,directory:string,targetCommit:string,authorized:WorktreeRepository[],approveIgnored?:(directory:string,paths:readonly string[])=>Promise<readonly string[]>) {
    requireValue(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(targetCommit),'WORKTREE_MODULE_TARGET_UNAVAILABLE');
    const listing=(await gitWorkspace(process,directory,['submodule','status','--recursive'])).stdout;
    const paths=listing.split('\n').filter(line=>line&&!line.startsWith('-')).map(line=>line.slice(1).trim().split(' ')[1]).sort();
    const modules:ModuleProof[]=[];
    for(const path of paths) {
        requireValue(!!path&&path.split('/').every(part=>/^[\w.-]+$/.test(part)&&part!=='.'&&part!=='..'),'WORKTREE_MODULE_SCOPE_INVALID');
        requireValue(authorized.some(row=>row.path===path||row.path!=='.'&&path.startsWith(row.path+'/')),'WORKTREE_MODULE_SCOPE_INVALID');
        const target=await pinnedModuleCommit(process,path,targetCommit,modules);
        modules.push(await inspectModule(process,directory,path,target,authorized.find(row=>row.path===path)?.baseCommit,approveIgnored));
    }
    requireValue(modules.length>0,'WORKTREE_MODULE_INSPECTION_UNKNOWN');
    return {modules,reasons:[...new Set(modules.flatMap(row=>row.reasons))],version:sha256HexSync(JSON.stringify(modules))};
}

async function pinnedModuleCommit(process:RemoteProcessHandle,path:string,targetCommit:string,modules:ModuleProof[]):Promise<string> {
    const parent=modules.filter(module=>path.startsWith(module.path+'/')).at(-1);
    const repo=parent?'/workspace/'+parent.path:'/workspace';
    const relative=parent?path.slice(parent.path.length+1):path;
    const entry=await gitWorkspace(process,repo,['ls-tree',parent?.target??targetCommit,'--',relative],true);
    const match=/^160000 commit ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(entry.stdout.trim());
    requireValue(entry.code===0&&match?.[2]===relative,'WORKTREE_MODULE_TARGET_UNAVAILABLE');
    return match[1];
}

async function inspectModule(process:RemoteProcessHandle,directory:string,path:string,targetHead:string,frozenHead:string|undefined,approveIgnored:((directory:string,paths:readonly string[])=>Promise<readonly string[]>)|undefined):Promise<ModuleProof> {
    const source=directory+'/'+path,target='/workspace/'+path;
    const head=(await gitWorkspace(process,source,['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
    const changed=(await gitWorkspace(process,source,['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=none'])).stdout;
    const ignored=(await gitWorkspace(process,source,['ls-files','--others','--ignored','--exclude-standard','--directory','--no-empty-directory','-z'])).stdout;
    const ignoredPaths=ignored.split('\0').filter(Boolean),removable=await approveIgnored?.(source,ignoredPaths)??[];
    const merged=await gitWorkspace(process,target,['merge-base','--is-ancestor',head,targetHead],true);
    requireValue(merged.code===0||merged.code===1,'WORKTREE_MODULE_INTEGRATION_UNKNOWN');
    return {path,head,target:targetHead,ignoredPaths,retainedIgnored:ignoredPaths.filter(entry=>!removable.includes(entry)),reasons:[changed&&'WORKTREE_DIRTY',ignoredPaths.some(entry=>!removable.includes(entry))&&'WORKTREE_UNTRACKED_IGNORED',merged.code===1&&head!==frozenHead&&'WORKTREE_NOT_INTEGRATED'].filter((value):value is string=>!!value)};
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

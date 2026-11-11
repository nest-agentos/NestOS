import {sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {GitProcess as RemoteProcessHandle} from './contracts';
import {gitWorkspace} from './worktree-modules';
import {requireValue} from './errors';
export interface ManagedBranch {repository:string;name:string}
export interface ManagedBranchState {branches:Array<ManagedBranch&{head:string}>;reasons:string[];version:string}
/** Explicit scope registration prevents prefix-based deletion of unrelated user branches. */
export async function readManagedBranches(fs:IFileSystem,directory:string,id:string,authorized:string[]):Promise<ManagedBranch[]>{
    const path=directory+'/_nestos/kanban/managed-resources.json',node=await fs.driver.getNode(path);
    if(!node)return [];
    requireValue(node.type==='file'&&node.size<=65536,'WORKTREE_BRANCH_MANIFEST_INVALID');
    const raw=await fs.driver.readContent(path,{encoding:'utf-8'}),value=JSON.parse(String(raw)) as {schema:string;scopeId:string;branches:ManagedBranch[]};
    requireValue(value.schema==='nestos.managed-resources/1'&&value.scopeId===id&&Array.isArray(value.branches)&&value.branches.length<=32,'WORKTREE_BRANCH_MANIFEST_INVALID');
    for(const branch of value.branches){
        requireValue(branch&&authorized.includes(branch.repository)&&typeof branch.name==='string'&&branch.name.length<=256,'WORKTREE_BRANCH_SCOPE_INVALID');
        requireValue(['backup','back','verify','fix'].some(kind=>branch.name.startsWith(kind+'/'+id+'/'))&&!branch.name.includes('..')&&!branch.name.includes('@{')&&!branch.name.endsWith('/'),'WORKTREE_BRANCH_SCOPE_INVALID');
    }
    requireValue(new Set(value.branches.map(branch=>JSON.stringify(branch))).size===value.branches.length,'WORKTREE_BRANCH_MANIFEST_INVALID');
    return value.branches;
}
export async function inspectManagedBranches(process:RemoteProcessHandle,declared:ManagedBranch[]):Promise<ManagedBranchState>{
    const branches:ManagedBranchState['branches']=[],reasons:string[]=[];
    for(const branch of declared){
        const root='/workspace'+(branch.repository==='.'?'':'/'+branch.repository);
        const ref=await gitWorkspace(process,root,['rev-parse','--verify','refs/heads/'+branch.name],true);if(ref.code!==0){requireValue((ref.code===1||ref.code===128),'WORKTREE_BRANCH_INSPECTION_FAILED');continue;}
        const head=ref.stdout.trim(),target=(await gitWorkspace(process,root,['rev-parse','--verify','HEAD^{commit}'])).stdout.trim();
        const listing=(await gitWorkspace(process,root,['worktree','list','--porcelain'])).stdout;
        if(listing.split('\n').includes('branch refs/heads/'+branch.name))reasons.push('WORKTREE_IN_USE');
        const merged=await gitWorkspace(process,root,['merge-base','--is-ancestor',head,target],true);requireValue((merged.code===0||merged.code===1),'WORKTREE_BRANCH_INSPECTION_FAILED');
        if(merged.code===1)reasons.push('WORKTREE_TEMP_BRANCH_NOT_INTEGRATED');branches.push({...branch,head});
    }
    return {branches,reasons:[...new Set(reasons)],version:sha256HexSync(JSON.stringify(branches))};
}
export async function removeManagedBranches(process:RemoteProcessHandle,state:ManagedBranchState):Promise<void>{
    const latest=await inspectManagedBranches(process,state.branches);
    requireValue(latest.version===state.version&&!latest.reasons.length,'WORKTREE_STATE_CHANGED');
    for(const branch of state.branches)await gitWorkspace(process,'/workspace'+(branch.repository==='.'?'':'/'+branch.repository),['branch','-d','--',branch.name]);
}

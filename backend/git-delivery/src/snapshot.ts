import {sha256HexSync} from '@nestos/common';
import type {GitProcess} from './contracts';
import type {PreparedWorktree} from './worktree-preparation';
import {inspectWorktree} from './worktree-status';
import {gitWorkspace,verifyWorktreeDelivery,type WorktreeRepository} from './worktree-modules';
import {requireValue} from './errors';
export interface GitSnapshot {version:string;sourceVersion:string;targetVersion:string;context:Record<string,unknown>}
export interface GitSourceRequest {projectId:string;tree:PreparedWorktree;repositories:WorktreeRepository[];availableRepositories?:WorktreeRepository[];commit:'changes'|'worktree';commitContext?:unknown}
/** Git evidence and version semantics are owned here; task and Session status are supplied elsewhere. */
export async function snapshotGitSource(process:GitProcess,input:GitSourceRequest) {
    const {tree}=input,status=await inspectWorktree(process,tree,'_nestos/kanban/');requireValue(status.exists,'WORKTREE_MISSING');
    const changes=await gitWorkspace(process,'/workspace',['status','--porcelain','--untracked-files=normal','--ignore-submodules=none']);
    const targetWorktree={dirty:!!changes.stdout.trim(),statusDigest:sha256HexSync(changes.stdout)};
    const repositories=await verifyWorktreeDelivery(process,tree.directory,input.repositories,input.commit,input.availableRepositories);
    const sourceVersion=sha256HexSync(JSON.stringify([input.projectId,tree.id,repositories])),targetVersion=status.targetHead;
    return {sourceVersion,targetVersion,version:sha256HexSync(JSON.stringify([sourceVersion,status.targetBranch,targetVersion])),context:{
        ...(input.commitContext?{commitContext:input.commitContext}:{}),commitPolicy:input.commit,projectId:input.projectId,worktreeId:tree.id,directory:tree.directory,branch:tree.branch,
        sourceHead:status.head,targetBranch:status.targetBranch,targetHead:targetVersion,targetWorktree,repositories}};
}
export function combineGitSnapshots(sources:Array<{identity:readonly string[];snapshot:GitSnapshot}>):GitSnapshot {
    requireValue(sources.length>0,'OPERATION_SOURCES_NOT_READY');const first=sources[0].snapshot,target=first.targetVersion;
    requireValue(sources.every(source=>source.snapshot.targetVersion===target),'OPERATION_TARGET_CHANGED');
    const sourceVersion=sha256HexSync(JSON.stringify(sources.map(source=>[...source.identity,source.snapshot.sourceVersion])));
    return {sourceVersion,targetVersion:target,version:sha256HexSync(JSON.stringify([sourceVersion,target,first.context.targetBranch,first.context.targetWorktree])),context:first.context};
}

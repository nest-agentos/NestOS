import type {GitProcess} from './contracts';
import type {PreparedWorktree} from './worktree-preparation';
import type {ManagedBranchState} from './managed-branches';
import {removeManagedBranches} from './managed-branches';
import {removeLinkedModuleWorktrees,type ModuleProof} from './worktree-removal-modules';
import {gitWorkspace} from './worktree-modules';
/** Consume a verified resource proof; the caller retains the durable cleanup intent and authorization fence. */
export async function removeGitWorktree(process:GitProcess,tree:PreparedWorktree,temporary:ManagedBranchState,modules?:{modules:ModuleProof[]}):Promise<void> {
    await removeManagedBranches(process,temporary);
    if(modules)await removeLinkedModuleWorktrees(process,tree.directory,modules.modules,tree.branch);
    await gitWorkspace(process,'/workspace',['worktree','remove',...(modules?['--force']:[]),tree.directory]);
    await gitWorkspace(process,'/workspace',['branch','-d',tree.branch]);
}

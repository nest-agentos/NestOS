import type {KanbanWorkResource} from '@nestos/kanban/contracts';
import {KanbanError} from '@nestos/kanban';

/** A blocked inspection is actionable evidence, not a running cleanup operation. */
export function assertWorkspaceCleanup(resource:KanbanWorkResource):void {
    if(resource.state==='cleaned'||resource.resolution?.kind==='ignored'||resource.canCleanup)return;
    const code=resource.reasons.find(reason=>/^WORKTREE_[A-Z_]{1,70}$/.test(reason))??'WORKTREE_CLEANUP_BLOCKED';
    throw Object.assign(new KanbanError(code),{cleanupPrecondition:true});
}

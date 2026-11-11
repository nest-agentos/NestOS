import {expect,it} from 'vitest';
import {assertWorkspaceCleanup} from '../src/kanban/workspace-cleanup-blocker';
import type {KanbanWorkResource} from '@nestos/kanban/contracts';
const resource=(reasons:string[],state='retained')=>({reasons,state,canCleanup:false}) as KanbanWorkResource;
it.each(['WORKTREE_ASSOCIATION_UNKNOWN','WORKTREE_OTHER_OWNER','WORKTREE_MISSING','WORKTREE_NOT_INTEGRATED'])('reports %s as a blocked cleanup precondition',code=>{
 expect(()=>assertWorkspaceCleanup(resource([code]))).toThrowError(expect.objectContaining({code,cleanupPrecondition:true}));
});
it('permits only cleanable or already cleaned resources and does not expose arbitrary reason text',()=>{
 expect(()=>assertWorkspaceCleanup({...resource([]),canCleanup:true})).not.toThrow();
 expect(()=>assertWorkspaceCleanup(resource([],'cleaned'))).not.toThrow();
 expect(()=>assertWorkspaceCleanup(resource(['PRIVATE_DETAILS']))).toThrowError(expect.objectContaining({code:'WORKTREE_CLEANUP_BLOCKED',cleanupPrecondition:true}));
});

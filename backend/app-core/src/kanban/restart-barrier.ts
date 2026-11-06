import type {KanbanClient} from '@nestos/kanban/contracts';
import {KanbanError} from '@nestos/kanban';
/** A settled dispatch does not prove a user has stopped a later native conversation turn. */
export function restartBarrier(client:()=>KanbanClient|undefined) {
    return async(board:string,ids:string[]):Promise<void>=>{
        const service=client();if(!service)throw new KanbanError('SERVICE_STARTING');
        for(const id of ids) {
            const state=await service.executionSession?.(board,id,{includeRelated:true});
            if(state?.sessionsCode||state?.sessions?.some(row=>['running','queued','unknown'].includes(row.state)))throw new KanbanError('RESTART_SESSION_NOT_IDLE');
            const resources=await service.workResources?.(board,id,{inspect:true});
            const blocker=resources?.flatMap(row=>row.reasons).find(reason=>['WORKTREE_IN_USE','WORKTREE_EXECUTION_UNKNOWN'].includes(reason));
            if(blocker)throw new KanbanError(blocker);
        }
    };
}

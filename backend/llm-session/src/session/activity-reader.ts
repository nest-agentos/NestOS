import type {Kernel} from '@nestos/durable-kernel';
import type {SessionActivity} from '@nestos/durable-kernel/contracts';
export type SessionExecutionPhase='running'|'waiting-approval'|'waiting-input'|'unknown'|'paused'|'queued'|'waiting'|'completed'|'failed'|'cancelled'|'idle';
export interface SessionActivitySummary {sessionId:string;state:SessionExecutionPhase;lastActivityAt?:number}
export type SessionActivityReader=(sessionId:string)=>Promise<SessionActivitySummary>;
/** Read actual execution activity without resuming a Session or exporting Kernel counters. */
export function createSessionActivityReader(kernel:Pick<Kernel,'sessionActivity'>):SessionActivityReader {
    return async sessionId=>{const activity=await kernel.sessionActivity(sessionId);
        if(activity.sessionId!==sessionId)throw Object.assign(new Error('SESSION_ACTIVITY_SCOPE_MISMATCH'),{code:'SESSION_ACTIVITY_SCOPE_MISMATCH'});
        return {sessionId,state:sessionExecutionPhase(activity),lastActivityAt:activity.lastActivityAt??activity.latestExit?.at};};
}
export function sessionExecutionPhase(activity: SessionActivity): SessionExecutionPhase {
    const {counts,pending}=activity;
    if(counts.running) return 'running';
    if(pending.approval) return 'waiting-approval';
    if(pending.input) return 'waiting-input';
    if(counts.blocked||pending.cleanup) return 'unknown';
    if(counts.paused||['suspended','suspending'].includes(activity.sessionStatus)) return 'paused';
    if(counts.queued||counts.created) return 'queued';
    if(counts.waiting) return 'waiting';
    return activity.latestExit ? ({succeeded:'completed',failed:'failed',cancelled:'cancelled'} as const)[activity.latestExit.status] : 'idle';
}

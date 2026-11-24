import type {KanbanClient,KanbanExecutionSessionDetail} from '@nestos/kanban/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger,randomUUID} from '@nestos/common';
import {KanbanError} from '@nestos/kanban';
import {safeCode} from '@nestos/kanban/integration';

type NativeIdle = (resourceId:string)=>Promise<boolean>;
const uncertain=['running','queued','unknown','waiting','waiting-input','waiting-approval'];
const log=createModuleLogger('kanban');

/** A settled dispatch does not prove a user has stopped a later native conversation turn. */
export function restartBarrier(client:()=>KanbanClient|undefined,nativeIdle?:NativeIdle) {
    return async(board:string,ids:string[]):Promise<void>=>{
        const service=client();if(!service)throw new KanbanError('SERVICE_STARTING');
        for(const id of ids) {
            const state=await service.executionSession?.(board,id,{includeRelated:true});
            if(state)await verifySessions(state,nativeIdle);
            const resources=await service.workResources?.(board,id,{inspect:true});
            const blocker=resources?.flatMap(row=>row.reasons).find(reason=>['WORKTREE_IN_USE','WORKTREE_EXECUTION_UNKNOWN'].includes(reason));
            if(blocker)throw new KanbanError(blocker);
        }
    };
}

async function verifySessions(state:KanbanExecutionSessionDetail,nativeIdle?:NativeIdle):Promise<void> {
    if(state.sessionsCode)throw new KanbanError('RESTART_SESSION_NOT_IDLE');
    const current=state.current;
    const sessions=state.sessions?.length?state.sessions:current?[current]:[];
    for(const row of sessions) {
        if(!uncertain.includes(row.state))continue;
        const resource=row.resourceId??(current?.sessionId===row.sessionId?current.resourceId:undefined);
        if(!resource||!nativeIdle||!await nativeIdle(resource))throw new KanbanError('RESTART_SESSION_NOT_IDLE');
    }
}

/** Resolve only the bound native Session and open its read-only observation. */
export function nativeRestartIdle(projects:Pick<ProjectService,'forFolder'|'remoteMounts'>):NativeIdle {
    return async resourceId=>{
        const target=resolveBrowserTarget(resourceId);
        const remote=projects.remoteMounts;
        if(!remote||target.kind!=='remote'||!target.profileId||!target.nativeSessionId)return false;
        const started=Date.now(),operationId=randomUUID();
        const event={operation:'kanban.restart',operationId,stage:'native.idle'};
        try {
            const project=await projects.forFolder(target.folder);
            if(!project||project.path!==target.folder)throw new KanbanError('RESTART_SESSION_BINDING_CHANGED');
            const idle=await readNativeIdle(remote,project.project.id,target.profileId,target.nativeSessionId);
            log.info('Native restart admission',{...event,result:idle?'success':'failure',code:idle?undefined:'RESTART_SESSION_NOT_IDLE',durationMs:Date.now()-started});
            return idle;
        } catch(error) {
            log.warn('Native restart admission',{...event,result:'failure',code:safeCode(error,'RESTART_SESSION_READ_FAILED'),durationMs:Date.now()-started});
            throw error;
        }
    };
}

async function readNativeIdle(remote:NonNullable<ProjectService['remoteMounts']>,projectId:string,profileId:string,sessionId:string):Promise<boolean> {
    const conversation=await remote.projectConversation(projectId,profileId,sessionId,{timeoutMs:3000},true);
    try {
        const state=await conversation.read({includeUsage:false}),observation=state.observation;
        return state.sessionId===sessionId&&observation.execution==='idle'&&observation.connection==='online'
            &&!observation.stale&&!observation.receiptUnknown&&!observation.refreshError&&!observation.activeTurnId
            &&!state.active&&!state.pending&&state.requests.length===0&&state.instructionQueue?.items.length===0;
    } finally {await conversation.close();}
}

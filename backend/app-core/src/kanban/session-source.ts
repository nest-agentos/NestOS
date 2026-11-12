import type {NativeSessionReader} from './native-session-activity';
import type {SessionActivityReader} from '@nestos/llm-session';
import type {ISessionRepository} from '@nestos/llm-session';
import type {KanbanBoard} from '@nestos/kanban/contracts';
import {KanbanError} from '@nestos/kanban';
import type {KanbanSessionSource} from '@nestos/kanban/activity';
/** Cold Session metadata only; never resumes, attaches, or exposes Task records. */
export function createLocalKanbanSessionSource(repository: Pick<ISessionRepository,'getManifest'>, readActivity:SessionActivityReader,resource?:(sessionId:string,branch:string,board?:KanbanBoard)=>Promise<string|undefined>,native?:NativeSessionReader): KanbanSessionSource {
    return {async authorizeBinding(_board,sessionId) {await sessionManifest(repository,sessionId);},async inspect(board,sessionId) {
        const manifest=await sessionManifest(repository,sessionId), activity=await readActivity(sessionId);
        if(activity.sessionId!==sessionId) throw new KanbanError('SESSION_ACTIVITY_SCOPE_MISMATCH');
        const lastActivityAt=activity.lastActivityAt;
        const resourceId=await resource?.(sessionId,manifest.currentBranch,board),observed=await native?.(board,sessionId,resourceId);
        return {sessionId,...(resourceId?{resourceId}:{}),title:manifest.title,createdAt:manifest.createdAt,state:activity.state,lastActivityAt,observedAt:Date.now(),stale:false,...observed};
    }};
}
async function sessionManifest(repository:Pick<ISessionRepository,'getManifest'>,sessionId:string) {
    try {return await repository.getManifest(sessionId);}
    catch(error) {if((error as {code?:string})?.code==='ENOENT') throw new KanbanError('SESSION_NOT_FOUND');throw error;}
}

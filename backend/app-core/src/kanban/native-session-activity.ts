import {createModuleLogger} from '@nestos/common';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {KanbanBoard,KanbanExecutionSession,KanbanSessionPhase} from '@nestos/kanban/contracts';
import type {PromptJournal} from '../run/prompt-bundle';
export type NativeSessionObservation=Pick<KanbanExecutionSession,'state'|'lastActivityAt'|'observedAt'|'stale'|'code'|'interactionIds'>;
export type NativeSessionReader=(board:KanbanBoard,sessionId:string,resourceId?:string)=>Promise<NativeSessionObservation|undefined>;
interface Execution {sessionId?:string;turnId?:string|null;status?:string;observedAt?:number}
interface Evidence {nativeSessionId:string;turnId?:string;state:KanbanSessionPhase;lastActivityAt?:number;observedAt:number}
/** Reuse channel observations; never enumerate native history or count polling as activity. */
export function nativeSessionActivity(journal:PromptJournal,now:()=>number=Date.now){
    const cache=new Map<string,Evidence>(),key=(boardId:string,sessionId:string)=>'native-session-observation:'+JSON.stringify([boardId,sessionId]);
    const record=async(boardId:string,sessionId:string|undefined,execution:Execution|undefined)=>{
        if(!sessionId||typeof execution?.sessionId!=='string')return;
        const started=Date.now();
        const id=key(boardId,sessionId),previous=cache.get(id)??await journal.get<Evidence>(id);
        const eventTime=typeof execution.observedAt==='number'&&Number.isFinite(execution.observedAt)&&execution.observedAt>=0?execution.observedAt:undefined;
        const lastActivityAt=nativePhase(execution.status)==='unknown'?previous?.lastActivityAt:eventTime;
        const value:Evidence={nativeSessionId:execution.sessionId,...(typeof execution.turnId==='string'?{turnId:execution.turnId}:{}),state:nativePhase(execution.status),...(lastActivityAt!==undefined?{lastActivityAt}:{}),observedAt:now()};
        if(!previous||JSON.stringify({...previous,observedAt:0})!==JSON.stringify({...value,observedAt:0})){await journal.update(id,()=>value);createModuleLogger('kanban').debug('Native session activity observed',{operation:'kanban.session.activity',operationId:sessionId,boardId,stage:'native.observe',result:'success',state:value.state,durationMs:Date.now()-started});}
        cache.delete(id);cache.set(id,value);if(cache.size>1000)cache.delete(cache.keys().next().value!);
    };
    const read:NativeSessionReader=async(board,sessionId,resourceId)=>{
        const target=resourceId?resolveBrowserTarget(resourceId):undefined;if(target?.kind!=='remote'||!target.nativeSessionId)return;
        const id=key(board.id,sessionId),live=cache.get(id),value=live??await journal.get<Evidence>(id);
        if(!value)return {state:'unknown',stale:true,lastActivityAt:undefined,code:'NATIVE_ACTIVITY_PENDING'};
        if(value.nativeSessionId!==target.nativeSessionId){createModuleLogger('kanban').warn('Native Session activity identity mismatch',{operation:'kanban.session.activity',operationId:sessionId,boardId:board.id,stage:'native.project',result:'failure',code:'NATIVE_ACTIVITY_SCOPE_MISMATCH',durationMs:0});return {state:'unknown',stale:true,lastActivityAt:undefined,code:'NATIVE_ACTIVITY_SCOPE_MISMATCH'};}
        const stale=!live||now()-value.observedAt>120000;
        return {state:stale&&['running','queued'].includes(value.state)?'unknown':value.state,lastActivityAt:value.lastActivityAt,observedAt:value.observedAt,stale,...(stale?{code:'NATIVE_ACTIVITY_STALE'}:{})};
    };
    return {record,read,clear:()=>cache.clear()};
}
function nativePhase(status:string|undefined):KanbanSessionPhase {
    if(status==='submitting')return 'queued';
    if(status==='interrupted')return 'cancelled';
    if(status==='rejected')return 'failed';
    return ['running','idle','completed','failed','cancelled'].includes(status??'')?status as KanbanSessionPhase:'unknown';
}

import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {createModuleLogger,randomUUID} from '@nestos/common';
import type {HarnessObservation} from '@nestos/cells-driver';
import {safeCode} from '@nestos/kanban/integration';
import type {RemoteSessionStatus} from '../session/remote-session-status';
import type {NativeSessionReader,NativeSessionObservation} from './native-session-activity';
interface Options {
    cached:NativeSessionReader;
    projects:Pick<ProjectService,'forFolder'>;
    status:Pick<RemoteSessionStatus,'get'|'read'>;
}
/** Reuse project metadata observation after work-channel settlement; never open native history. */
export function currentNativeSessionReader(options:Options):NativeSessionReader {
    return async(board,sessionId,resourceId)=>{
        const previous=await options.cached(board,sessionId,resourceId);
        if(!resourceId||previous?.code==='NATIVE_ACTIVITY_SCOPE_MISMATCH')return previous;
        const target=resolveBrowserTarget(resourceId);
        if(target.kind!=='remote'||!target.profileId||!target.nativeSessionId)return previous;
        const started=Date.now(),operationId=randomUUID();
        try {
            const project=await options.projects.forFolder(target.folder);
            if(!project||project.path!==target.folder)throw Object.assign(new Error('Native project binding mismatch'),{code:'NATIVE_ACTIVITY_SCOPE_MISMATCH'});
            const id=project.project.id;
            let observation=options.status.get(id,target.profileId,target.nativeSessionId);
            if(!observation||observation.stale||Date.now()-observation.observedAt>=15_000){
                await options.status.read(id);observation=options.status.get(id,target.profileId,target.nativeSessionId);
                createModuleLogger('kanban').debug('Native Session status refreshed',{operation:'kanban.session.activity',operationId,sessionId,
                    stage:'native.status',result:observation&&!observation.stale?'success':'failure',code:observation?undefined:'NATIVE_ACTIVITY_PENDING',durationMs:Date.now()-started});
            }
            return observation?projectObservation(observation,previous):previous;
        }catch(error){
            const code=safeCode(error,'NATIVE_ACTIVITY_READ_FAILED');
            createModuleLogger('kanban').warn('Native Session metadata unavailable',{operation:'kanban.session.activity',operationId,sessionId,stage:'native.status',result:'failure',code,durationMs:Date.now()-started});
            return {...previous,state:'unknown',stale:true,code};
        }
    };
}
function projectObservation(observation:HarnessObservation,previous:NativeSessionObservation|undefined):NativeSessionObservation {
    const stale=observation.stale||observation.connection!=='online'||Date.now()-observation.observedAt>30_000;
    const state=observation.execution==='idle'?observation.lastResult??'idle':observation.execution;
    return {state:stale&&state==='running'?'unknown':state,lastActivityAt:previous?.lastActivityAt,
        interactionIds:observation.interactionIds,observedAt:observation.observedAt,stale,code:observation.refreshError?.code??(stale?'NATIVE_ACTIVITY_STALE':undefined)};
}

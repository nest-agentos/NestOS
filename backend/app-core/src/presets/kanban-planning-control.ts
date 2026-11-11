import type {developmentPreparation, DevelopmentWorkspaceRecord} from './kanban-development';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {CallLifecyclePorts} from '../kanban/call-lifecycle';
import {requireValue} from '../kanban/validation';
type Options=Pick<Parameters<typeof developmentPreparation>[0],'remote'|'connections'>;
type Request=Parameters<NonNullable<CallLifecyclePorts['controlConversation']>>[0];
interface Execution {sessionId?:string;turnId?:string;status?:string;revision?:number}
interface Frozen {phase:'prepared'|'submitting';sessionId:string;turnId:string;epoch:string}

/** Control the retained native conversation separately from its already settled initial call. */
export function planningConversationControl(options:Options,journal:KanbanAutomationJournal) {
    return async(input:Request):Promise<import('@nestos/llm-session').SubmissionControlState>=>{
        const record=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.scopeId);
        requireValue(record,'SESSION_CHANNEL_WORKSPACE_REQUIRED');
        const read=async()=>await options.remote.sessionChannel(record.projectId,'messages',{scopeId:input.scopeId}) as {execution?:Execution};
        const {execution}=await read();requireValue(execution?.sessionId,'PLANNING_SOURCE_UNVERIFIED');
        const terminal=['completed','failed','interrupted','cancelled','rejected','idle'].includes(execution.status??'');
        if(input.action!=='cancel') {requireValue(terminal,'TASK_CONTROL_UNSUPPORTED');return input.action==='pause'?'paused':'resumed';}
        if(terminal){
            await options.remote.sessionChannel(record.projectId,'close',{scopeId:input.scopeId,expectedExecutionRevision:execution.revision,requireIdle:true});
            return 'cancelled';
        }
        if(execution.status!=='running'||!execution.turnId)return 'unknown';
        const binding=await options.connections.get('work-'+(record.worktreeId??input.scopeId));
        requireValue(binding?.connection,'NATIVE_CONNECTION_REQUIRED');
        const client=await options.remote.projectHarness(record.projectId),profile=binding.connection.profileId;
        try {
            const key='planning-control:'+JSON.stringify([input.scopeId,input.operationId]);
            const existing=await journal.get<Frozen>(key),catalogEpoch=existing?undefined:(await client.profiles()).epoch;
            const frozen=existing??await journal.update<Frozen>(key,old=>old??{phase:'prepared',sessionId:execution.sessionId!,turnId:execution.turnId!,epoch:catalogEpoch!});
            if(await journal.claim(key))await client.interrupt(profile,frozen.sessionId,frozen.turnId,{requestId:input.operationId,epoch:frozen.epoch});
            else {const receipt=await client.operation(profile,input.operationId,{epoch:frozen.epoch});if(receipt.outcome==='unknown')return 'unknown';if(receipt.outcome==='not-committed')throw Object.assign(new Error('Cancellation was rejected'),{code:receipt.code??'TASK_CONTROL_REJECTED',cancelRejected:true});}
            return 'accepted';
        }finally{await client.close();}
    };
}

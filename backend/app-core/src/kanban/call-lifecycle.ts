import {controlIndependentCall,independentCallSettled,type DurableCallControlPorts} from '@nestos/llm-session';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {KanbanError} from '@nestos/kanban';
export interface CallLifecyclePorts {
    beforeCancel?:import('@nestos/kanban/integration').KanbanTaskControlOptions['beforeCancel'];
    controlConversation?(input:{scopeId:string;operationId:string;action:'pause'|'resume'|'cancel'}):Promise<import('../run/submission-control').SubmissionControlState>;
    calls: DurableCallControlPorts['calls'];
    submissionControl?(input: import('../run/submission-control').SubmissionControlRequest, journal: import('../run/submission-control').ControlJournal): Promise<import('../run/submission-control').SubmissionControlState>;
    callControl?: DurableCallControlPorts['callControl'];
    callCancel?: DurableCallControlPorts['callCancel'];
}
export const callSettled=independentCallSettled;
/** Keep existing host journal keys and the direct-submission fallback during migration. */
export async function controlCall(options:CallLifecyclePorts,journal:KanbanAutomationJournal,sessionId:string,requestId:string,action:'pause'|'resume'|'cancel',callId=sessionId,legacyKey?:string,directSubmission=false){
    try{return await controlIndependentCall({calls:options.calls,callControl:options.callControl?.bind(options),callCancel:options.callCancel?.bind(options),log:event=>journal.diagnostic({...event,stage:'session.'+event.stage})},journal,{sessionId,requestId,callId,action},{key:'call-lifecycle:'+JSON.stringify([sessionId,requestId]),legacyKey});}
    catch(error){
        const code=(error as {code?:string})?.code;
        if(code==='CALL_CONTROL_NOT_FOUND'&&directSubmission&&options.submissionControl)return options.submissionControl({sessionId,submissionId:callId,requestId,action},journal);
        if(code?.startsWith('CALL_CONTROL_'))throw new KanbanError(code==='CALL_CONTROL_NOT_FOUND'?'TASK_CONTROL_ROUTE_MISSING':code.replace('CALL_CONTROL_','TASK_CONTROL_'));
        throw error;
    }
}

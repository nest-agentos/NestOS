import type {KanbanAutomationJournal,KanbanTaskControlOptions,KanbanControlRequest} from '@nestos/kanban/integration';
import {callSettled,controlCall,type CallLifecyclePorts} from './call-lifecycle';
import {kanbanReferences} from './work-log-policy';
import {requireValue} from './validation';
import {createModuleLogger} from '@nestos/common';
const log=createModuleLogger('KanbanControl');

export function kanbanControlOptions(options:CallLifecyclePorts,journal:KanbanAutomationJournal):KanbanTaskControlOptions {
    return {beforeCancel:options.beforeCancel,references:kanbanReferences,finalizerPrefix:'development-lifecycle:',control:{
        control:async input=>{
            const route=executionRoute(input);
            if(input.kind==='conversation'){
                requireValue(options.controlConversation,'TASK_CONTROL_UNSUPPORTED');
                const view=(await options.calls.list({sessionId:route.executionId,branchId:'main'})).find(row=>row.input.request.submission?.id===route.attemptId);
                requireValue(view,'TASK_CONTROL_ROUTE_MISSING');
                if(!callSettled(view)){
                    const result=await controlCall(options,journal,route.executionId,input.operationId+'-call',input.action,route.attemptId);
                    if(result!==(input.action==='cancel'?'cancelled':input.action==='pause'?'paused':'resumed'))return result;
                }
                return options.controlConversation({scopeId:input.executionId,operationId:input.operationId,action:input.action});
            }
            if(input.kind==='submission'){
                requireValue(options.submissionControl,'TASK_CONTROL_UNSUPPORTED');
                return options.submissionControl({sessionId:route.executionId,submissionId:route.attemptId,requestId:input.operationId,action:input.action},journal);
            }
            try{return await controlCall(options,journal,route.executionId,input.operationId,input.action,route.attemptId,input.previousKey,input.fallbackSubmission);}
            catch(error){
                const code=(error as {code?:string}).code;
                if(input.action!=='cancel'||!input.observationSessionId||!options.submissionControl||!['ENOENT','TASK_CONTROL_ROUTE_MISSING'].includes(code??''))throw error;
                const started=Date.now(),state=await options.submissionControl({sessionId:input.observationSessionId,submissionId:route.attemptId,requestId:input.operationId,action:'cancel'},journal);
                log.info('control.reconcile',{operationId:input.operationId,stage:'canonical-submission-control',result:state==='cancelled'?'success':'failure',code,durationMs:Date.now()-started});
                return state;
            }
        },
        inspect:async(executionId,attemptId=executionId)=>{
            const rows=await options.calls.list({sessionId:executionId,branchId:'main'}),view=rows.find(row=>row.input.request.submission?.id===attemptId);
            return view?{settled:callSettled(view),outcome:view.executionState?.exitStatus??view.callerState?.exitStatus}:undefined;
        },
    }};
}
function executionRoute(input:KanbanControlRequest):{executionId:string;attemptId:string} {
    if(input.prepared===undefined)return {executionId:input.executionId,attemptId:input.attemptId??input.executionId};
    const value=input.prepared as {request?:unknown},request=(value?.request??value) as {expectedSessionId?:string;submission?:{id?:string}};
    requireValue(request?.expectedSessionId&&request.submission?.id,'TASK_CONTROL_ROUTE_MISSING');
    return {executionId:request.expectedSessionId,attemptId:request.submission.id};
}

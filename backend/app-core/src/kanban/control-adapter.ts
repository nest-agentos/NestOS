import type {KanbanAutomationJournal,KanbanTaskControlOptions,KanbanControlRequest} from '@nestos/kanban/integration';
import {callSettled,controlCall,type CallLifecyclePorts} from './call-lifecycle';
import {kanbanReferences} from './work-log-policy';
import {requireValue} from './validation';

export function kanbanControlOptions(options:CallLifecyclePorts,journal:KanbanAutomationJournal):KanbanTaskControlOptions {
    return {references:kanbanReferences,finalizerPrefix:'development-lifecycle:',control:{
        control:async input=>{
            const route=executionRoute(input);
            if(input.kind==='submission'){
                requireValue(options.submissionControl,'TASK_CONTROL_UNSUPPORTED');
                return options.submissionControl({sessionId:route.executionId,submissionId:route.attemptId,requestId:input.operationId,action:input.action},journal);
            }
            return controlCall(options,journal,route.executionId,input.operationId,input.action,route.attemptId,input.previousKey,input.fallbackSubmission);
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

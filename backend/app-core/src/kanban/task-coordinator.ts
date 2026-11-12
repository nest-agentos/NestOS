import {validateCoordinationResult,safeCode,createTaskCoordinator,currentAnalysis,type CoordinationOperation,type CoordinationSnapshot} from '@nestos/kanban/integration';
import type {IndependentCallInput,SubmissionRequest} from '@nestos/llm-session/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal,KanbanWorkLog} from '@nestos/kanban/integration';

import {workContext} from './work-context';
import {requireValue} from './validation';
import {readPlanningChannel} from '../run/planning-channel';
interface Options extends PersonalKanbanAutomationOptions {service:KanbanService;journal:KanbanAutomationJournal;workLog?:KanbanWorkLog}
export function taskCoordinator(options:Options) {
    if(!options.collaboration||!options.sessionChannel)return;
    return createTaskCoordinator({service:options.service,journal:options.journal,prepare:(id,snapshot)=>prepare(options,id,snapshot),port:{
        start:async job=>{await options.collaboration!.submission.start(job.request as SubmissionRequest);},
        inspect:job=>inspect(options,job),
        validate:(job,output)=>validateCoordinationResult(output,job.snapshot.children,[...new Set((options.operationPlugins??[]).flatMap(plugin=>plugin.actions.filter(action=>action.coordination!==false).map(action=>action.id)))]),
        classify:error=>({code:safeCode(error,'COORDINATION_FAILED'),disposition:(error as {executionOutcome?:string}).executionOutcome==='not-started'?'retry-unstarted':['COORDINATION_RESULT_INVALID','CHANNEL_RESULT_INVALID','CHANNEL_RESULT_CHANGED'].includes(safeCode(error,''))?'terminal':'unknown'}),
        report:async job=>{await options.notifyCoordination?.(job);if(job.phase!=='settled')return;const key='coordination-reported:'+job.id;if(await options.journal.get(key))return;
            await options.workLog?.append(options.service,job.boardId,job.itemId,{stage:'coordination.'+job.state,result:job.state==='succeeded'?'success':'failure',dispatchId:job.id,code:job.code,
                references:job.sessionId?[{system:'nestos-coordination-session',id:job.sessionId,revision:job.id}]:[]});
            await options.journal.update(key,old=>old??true);},
    }});
}
async function prepare(options:Options,id:string,snapshot:CoordinationSnapshot) {
    const analysis=await currentAnalysis<IndependentCallInput>(options.journal,snapshot.boardId,snapshot.parent.id);
    requireValue(analysis?.input,'COORDINATION_SESSION_UNAVAILABLE');
    const original=await options.originalSession(analysis.input);
    const fixId=await options.journal.get<string>('fix-session:'+original.sessionId);
    const fix=fixId?await options.journal.get<{accepted?:boolean;state:string}>('fix:'+fixId):undefined;
    requireValue(!fix||fix.accepted||fix.state==='cancelled','COLLABORATION_IN_USE');
    const board=await options.service.read(snapshot.boardId);
    const context={...await workContext(options.journal,board,snapshot.parent),coordination:{automatic:true,...snapshot}};
    const instruction=await options.collaboration!.prepare({id,originId:analysis.id,...original,context,item:snapshot.parent,board});
    return original.request(id,instruction+' This is an automatic state event: publish a coordination result with ready=true; do not wait for user confirmation unless a real clarification is required.');
}
async function inspect(options:Options,job:CoordinationOperation) {
    const request=job.request as SubmissionRequest,workspace=await options.journal.get<{projectId:string}>('development-workspace:'+job.id);
    const projectId=workspace?.projectId??job.snapshot.parent.externalRefs?.find(ref=>ref.system==='nestos-remote-project')?.id;
    requireValue(projectId&&options.sessionChannel,'SESSION_CHANNEL_REQUIRED');
    const result=await readPlanningChannel({sessionChannel:options.sessionChannel},projectId,job.id,options.journal);
    if(result?.state==='succeeded')return {state:'succeeded' as const,executionId:request.expectedSessionId,output:result.output};
    if(result?.state==='failed'||result?.state==='cancelled')return {state:'failed' as const,executionId:request.expectedSessionId,code:result.code??'COORDINATION_FAILED'};
    if(result?.state==='blocked')return {state:'running' as const,executionId:request.expectedSessionId,code:result.code??'WORKSPACE_ERROR_REPORTED'};
    if(result?.state==='running')return {state:'running' as const,executionId:request.expectedSessionId,code:'COORDINATION_RESULT_PENDING'};
    if(result?.state==='clarification')return {state:'running' as const,executionId:request.expectedSessionId,code:'WORKSPACE_INPUT_REQUIRED'};
    const state=await options.collaboration!.submission.inspect(request);
    return {state:state.outcome==='cancelled'?'failed' as const:state.outcome==='succeeded'?'unknown' as const:state.outcome,executionId:state.sessionId,code:state.code??(state.outcome==='succeeded'?'COORDINATION_RESULT_PENDING':undefined)};
}

export function coordinationNotifications(events:import('../events/service').UserEventService):NonNullable<PersonalKanbanAutomationOptions['notifyCoordination']> {
    return async job=>{
        if(job.phase!=='settled'&&!job.code)return;
        const kind=job.code==='WORKSPACE_INPUT_REQUIRED'?'clarification':job.phase==='settled'&&job.state==='succeeded'?'completed':'error';
        await events.journal.transaction(async tx=>{
            const key='coordination-notify:'+job.id+':'+kind+':'+(job.code??'');if(await tx.getState(key))return;
            await tx.append(key,{type:'kanban.coordination.'+kind,operationId:job.id,resourceId:'kanban:'+JSON.stringify(['personal:user-store',job.boardId,job.itemId]),notification:kind==='error'?'error':'info'},Date.now());
            await tx.setState(key,'delivered');
        });
    };
}

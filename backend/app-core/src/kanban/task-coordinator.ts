import {safeCode,createTaskCoordinator,currentAnalysis,type CoordinationOperation,type CoordinationSnapshot} from '@nestos/kanban/integration';
import type {IndependentCallInput,SubmissionRequest} from '@nestos/llm-session/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal,KanbanWorkLog} from '@nestos/kanban/integration';
import {originalSession} from './session-operation';
import {workContext} from './work-context';
import {requireValue} from './validation';
import {readPlanningChannel} from '../run/planning-channel';
interface Options extends PersonalKanbanAutomationOptions {service:KanbanService;journal:KanbanAutomationJournal;workLog?:KanbanWorkLog}
export function taskCoordinator(options:Options) {
    if(!options.collaboration||!options.sessionChannel)return;
    return createTaskCoordinator({service:options.service,journal:options.journal,prepare:(id,snapshot)=>prepare(options,id,snapshot),port:{
        start:async job=>{await options.collaboration!.submission.start(job.request as SubmissionRequest);},
        inspect:job=>inspect(options,job),
        validate:(_job,output)=>{const result=output as {schema?:string;summary?:string;suggestions?:unknown[]};
            requireValue(result?.schema==='kanban.coordination/1'&&typeof result.summary==='string'&&result.summary.length<=8000&&Array.isArray(result.suggestions)&&result.suggestions.length<=16,'COORDINATION_RESULT_INVALID');
            const children=new Set(_job.snapshot.children.map(child=>child.id));
            requireValue(result.suggestions.every(raw=>{const suggestion=raw as {itemId?:string;action?:string;reason?:string};return typeof suggestion.itemId==='string'&&children.has(suggestion.itemId)&&typeof suggestion.action==='string'&&['analyze','build','deploy','accept','merge'].includes(suggestion.action)&&typeof suggestion.reason==='string'&&suggestion.reason.length<=2000;}),'COORDINATION_RESULT_INVALID');},
        classify:error=>({code:safeCode(error,'COORDINATION_FAILED'),disposition:(error as {executionOutcome?:string}).executionOutcome==='not-started'?'retry-unstarted':'unknown'}),
        report:async job=>{await options.notifyCoordination?.(job);if(job.phase!=='settled')return;const key='coordination-reported:'+job.id;if(await options.journal.get(key))return;
            await options.workLog?.append(options.service,job.boardId,job.itemId,{stage:'coordination.'+job.state,result:job.state==='succeeded'?'success':'failure',dispatchId:job.id,code:job.code,
                references:job.sessionId?[{system:'nestos-coordination-session',id:job.sessionId,revision:job.id}]:[]});
            await options.journal.update(key,old=>old??true);},
    }});
}
async function prepare(options:Options,id:string,snapshot:CoordinationSnapshot) {
    const analysis=await currentAnalysis<IndependentCallInput>(options.journal,snapshot.boardId,snapshot.parent.id);
    requireValue(analysis?.input,'COORDINATION_SESSION_UNAVAILABLE');
    const original=await originalSession(options,analysis.input);
    const fixId=await options.journal.get<string>('fix-session:'+original.sessionId);
    const fix=fixId?await options.journal.get<{accepted?:boolean;state:string}>('fix:'+fixId):undefined;
    requireValue(!fix||fix.accepted||fix.state==='cancelled','COLLABORATION_IN_USE');
    const board=await options.service.read(snapshot.boardId);
    const context={...await workContext(options.journal,board,snapshot.parent),coordination:{automatic:true,...snapshot}};
    const instruction=await options.collaboration!.prepare({id,originId:analysis.id,...original,context,item:snapshot.parent,board});
    return original.request(id,instruction+' This is an automatic state event: publish a coordination result with ready=true; do not wait for user confirmation unless a real clarification is required.');
}
async function inspect(options:Options,job:CoordinationOperation) {
    const request=job.request as SubmissionRequest,resource=job.snapshot.parent.externalRefs?.find(ref=>ref.system==='nestos-remote-project');
    requireValue(resource&&options.sessionChannel,'SESSION_CHANNEL_REQUIRED');
    const result=await readPlanningChannel({sessionChannel:options.sessionChannel},resource.id,job.id,options.journal);
    if(result?.state==='succeeded')return {state:'succeeded' as const,executionId:request.expectedSessionId,output:result.output};
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

import {sha256HexSync,t} from '@nestos/common';
import {journalCommand,safeCode} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanItem,KanbanItemOperationRequest,KanbanItemOperation,KanbanOperationWaiver} from '@nestos/kanban/contracts';
import type {DeliveryPlan,ReviewJob,ReviewOperationsOptions} from './item-operation-types';
import {requireValue} from './validation';
const defaultSteps=['build','deploy','accept','analyze','merge','cleanup'];
export const operationSteps=(configured:string[]=defaultSteps,ordering?:'configured')=>(ordering==='configured'?[...new Set(configured)]:defaultSteps).filter(id=>defaultSteps.includes(id)&&configured.includes(id));
export function operationGroup(id:string):NonNullable<KanbanItemOperation['group']> {
    const stage=id==='analyze'||id==='cleanup'?'merge':id;
    return {id:stage,label:t(('kanban.operationStage.'+stage) as Parameters<typeof t>[0])};
}
export function operationDependencies(plan?:DeliveryPlan):Record<string,string[]> {
    const steps=operationSteps(plan?.steps,plan?.ordering);
    return Object.fromEntries(steps.map((id,index)=>[id,index?[steps[index-1]]:[]]));
}
/** Verification waivers do not waive the independent source submission. */
export function operationSkipDependencies(plan?:DeliveryPlan):Record<string,string[]> {
    const submission=new Set(['analyze','merge','cleanup']);
    return Object.fromEntries(Object.entries(operationDependencies(plan)).map(([id,deps])=>
        [id,deps.filter(dep=>submission.has(id)===submission.has(dep))]));
}
export function affectedOperations(graph:Record<string,string[]>,action:string):string[] {
    const affected=new Set([action]);let previous=0;
    while(previous!==affected.size){previous=affected.size;for(const [id,deps] of Object.entries(graph))if(deps.some(dep=>affected.has(dep)))affected.add(id);}
    return Object.keys(graph).filter(id=>affected.has(id));
}
/** Only explicitly confirmed operations are waived, including historical policies. */
export function effectiveOperationWaivers(waivers:KanbanOperationWaiver[],plan?:DeliveryPlan):KanbanOperationWaiver[] {
    const graph=operationDependencies(plan);
    return waivers.filter(row=>row.operations.some(operation=>Object.hasOwn(graph,operation.id))).map(row=>{
        const operations=row.operations.filter(op=>Object.hasOwn(graph,op.id));
        return {...row,acceptanceWaived:row.acceptanceWaived&&operations.some(op=>op.id==='accept'),operations};
    });
}

export function projectOperationSkips(operations:KanbanItemOperation[],plan:DeliveryPlan|undefined,waivers:KanbanOperationWaiver[],eligible:boolean):KanbanItemOperation[] {
    const graph=operationDependencies(plan),skipGraph=operationSkipDependencies(plan);
    return operations.map(entry=>{
        const record=waivers.filter(row=>row.operations.some(op=>op.id===entry.id)).at(-1),row=record?.operations.find(op=>op.id===entry.id);
        if(record&&row&&entry.progress)return {...entry,enabled:false,hideRun:true,followUp:undefined,dependsOn:graph[entry.id],reason:t('kanban.operationWaiverWaitingStop')};
        if(record&&row)return {...entry,state:'skipped',reason:undefined,progress:undefined,enabled:false,hideRun:true,fields:undefined,confirmation:undefined,configurable:false,followUp:undefined,dependsOn:graph[entry.id],waiver:{id:record.id,cause:row.cause,action:record.action,reason:record.reason,actor:record.actor,at:record.at}};
        const affected=affectedOperations(skipGraph,entry.id),consumed=operations.some(op=>affectedOperations(graph,entry.id).includes(op.id)&&op.state==='succeeded');
        return {...entry,...(waivers.some(row=>row.operations.some(op=>op.id==='deploy'))?{followUp:undefined}:{}),dependsOn:graph[entry.id],...(!eligible||consumed||entry.state==='succeeded'?{}:{skip:{affected:affected.map(id=>({id,label:operations.find(op=>op.id===id)?.label??t(('kanban.operationAction.'+id) as Parameters<typeof t>[0]),group:operationGroup(id)}))}})};
    });
}
interface Context {board:KanbanBoard;item:KanbanItem;jobs:ReviewJob[];deliveryPlan?:DeliveryPlan}
export async function skipItemOperations(options:ReviewOperationsOptions,context:Context,request:KanbanItemOperationRequest,entries:KanbanItemOperation[]):Promise<void> {
    const started=Date.now();
    const input=request.skip!,fingerprint=sha256HexSync(JSON.stringify([context.board.id,request])),key='review-skip:'+request.operationId;
    const saved=await options.journal.get<{fingerprint:string;errorCode?:string}>(key);requireValue(!saved||saved.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');
    if(saved){requireValue(!saved.errorCode,saved.errorCode??'OPERATION_SKIP_FAILED');await applySkipIntent(options,key,context.board.id);return;}
    requireValue(request.confirmed===true,'OPERATION_CONFIRMATION_REQUIRED');
    requireValue(typeof input.reason==='string'&&input.reason.trim().length>0&&input.reason.length<=2000,'OPERATION_SKIP_REASON_REQUIRED');
    requireValue(!context.jobs.some(job=>job.phase!=='settled'),'OPERATION_IN_USE');
    const entry=entries.find(row=>row.id===input.action),affected=entry?.skip?.affected.map(row=>row.id);
    requireValue(affected&&Array.isArray(input.affected)&&JSON.stringify([...input.affected].sort())===JSON.stringify([...affected].sort()),'OPERATION_SKIP_IMPACT_CHANGED');
    const workflow=await options.service.workflow(context.board.id),dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===context.item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    requireValue(dispatch&&['succeeded','accepted'].includes(dispatch.outcome),'OPERATION_ACCEPTANCE_UNAVAILABLE');
    const waiver={id:request.operationId,action:input.action,reason:input.reason.trim(),acceptanceWaived:affected.includes('accept'),dependencies:operationSkipDependencies(context.deliveryPlan),
        operations:affected.map(id=>({id,cause:id===input.action?'direct' as const:'dependency' as const,previousState:entries.find(row=>row.id===id)?.state??'unavailable',...(entries.find(row=>row.id===id)?.runId?{previousRunId:entries.find(row=>row.id===id)!.runId}:{})}))};
    await options.journal.update<Array<{board:string;item:string}>>('review-operation-scopes',old=>old?.some(row=>row.board===context.board.id&&row.item===context.item.id)?old:[...old??[],{board:context.board.id,item:context.item.id}]);
    await options.journal.update<Array<{key:string;board:string}>>('review-skip-intents',old=>old?.some(row=>row.key===key)?old:[...old??[],{key,board:context.board.id}]);
    await options.journal.update(key,old=>old??{fingerprint,command:{type:'waive-operations',itemId:context.item.id,dispatchId:dispatch.id,expectedItemRevision:context.item.revision,waiver}});
    options.log({operationId:request.operationId,stage:'operation.skip.intent',result:'success',durationMs:Date.now()-started});
    await applySkipIntent(options,key,context.board.id);
}
export async function applySkipIntent(options:ReviewOperationsOptions,key:string,board:string):Promise<void> {
    const intent=await options.journal.get<{command:import('@nestos/kanban/contracts').KanbanCommand;done?:boolean}>(key);if(!intent||intent.done){await removeSkipIntent(options,key);return;}
    const started=Date.now();
    try {await journalCommand(options.journal,options.service,board,key+':command',intent.command);await options.journal.update(key,old=>({...old as object,done:true}));await removeSkipIntent(options,key);
        options.log({operationId:key,stage:'operation.skip.commit',result:'success',durationMs:Date.now()-started});}
    catch(error){const code=safeCode(error,'OPERATION_SKIP_FAILED');
        if(['OPERATION_STALE_REFRESH','TASK_CANCELLING','EXECUTION_NOT_SUCCEEDED','COORDINATOR_REQUIRED','OPERATION_COORDINATOR_REQUIRED'].includes(code)){await options.journal.update(key,old=>({...old as object,done:true,errorCode:code}));await removeSkipIntent(options,key);}
        options.log({operationId:key,stage:'operation.skip.commit',result:'failure',code,durationMs:Date.now()-started});throw error;}
}

async function removeSkipIntent(options:ReviewOperationsOptions,key:string):Promise<void> {
    await options.journal.update<Array<{key:string;board:string}>>('review-skip-intents',old=>old?.filter(row=>row.key!==key)??[]);
}

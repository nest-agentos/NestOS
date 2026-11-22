import {operationRuntimeVersion} from './item-operation-runtime';
import {developmentAnalysisPolicy} from './development-operation-policy';
import {invalidateReviewAnalysis,revalidateMergeAdmission,settleRejectedMerge} from '@nestos/kanban/integration';
import {cancellationKey,pendingCancellation,blocksOperation,type ReviewCancellation} from '@nestos/kanban/integration';
import {validateOperationResult} from '@nestos/git-delivery/results';
import {indexResourceJob} from '@nestos/kanban/integration';
import {coordinateOperation} from '@nestos/kanban/integration';
import type {KanbanBoard, KanbanItem, KanbanItemOperationRequest} from '@nestos/kanban/contracts';
import {sha256HexSync} from '@nestos/common';
import {automationTarget} from './automation-targets';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';
import { type ReviewJob, type ReviewOperationsOptions, type ReviewSettings, type ReviewAction} from './item-operation-types';
import {jobKey} from '@nestos/kanban/integration';

export async function prepareReviewJob(options: ReviewOperationsOptions, board: KanbanBoard, item: KanbanItem,
    settings: ReviewSettings, request: KanbanItemOperationRequest, context?: unknown,expectedAcceptanceSource?:string): Promise<ReviewJob> {
    const snapshot = await preparationStage(options, request.operationId, 'snapshot', () => options.adapter.snapshot(board, item)), action = request.action as ReviewAction;
    if(action==='analyze'&&expectedAcceptanceSource!==undefined)await preparationStage(options,request.operationId,'acceptance-source',async()=>requireValue(snapshot.sourceVersion===expectedAcceptanceSource,'OPERATION_SOURCE_CHANGED_REBUILD'));
    const base: ReviewJob = {id: request.operationId, boardId: board.id, itemId: item.id, scopeId:options.scopeId, action, snapshot,operationContext:context,
        fingerprint: sha256HexSync(JSON.stringify(request)), phase:'prepared',state:'running',createdAt:Date.now(),...(request.followUp==='deploy'?{followUp:{action:'deploy' as const,state:'queued' as const}}:{})};
    if (action === 'deploy' || action === 'merge') {
        const evidence=context as {analysisId?:string;sourceVersion?:string;targetVersion?:string};
        const analysis=action==='merge'&&evidence?.analysisId?await options.journal.get<ReviewJob>(jobKey(evidence.analysisId)):undefined;
        if(evidence?.sourceVersion!==snapshot.sourceVersion||evidence.targetVersion!==snapshot.targetVersion||analysis&&analysis.snapshot.version!==snapshot.version){
            const code=evidence?.sourceVersion!==snapshot.sourceVersion?'OPERATION_SOURCE_CHANGED_REANALYZE':'OPERATION_TARGET_CHANGED_REANALYZE';
            if(analysis)await invalidateReviewAnalysis({...options,policy:developmentAnalysisPolicy},board.id,item.id,analysis.id,code,request.operationId);requireValue(false,code);
        }
    }
    if(action==='deploy'&&options.adapter.managed){const managed=await options.adapter.managed.prepare({id:base.id,board,item,snapshot,context});if(managed)return {...base,operationContext:context,managed};}
    if (options.adapter.prepareOperation) {
        requireValue(action !== 'accept', 'OPERATION_REQUEST_INVALID');
        const request = await preparationStage(options, base.id, 'session', () => options.adapter.prepareOperation!({id: base.id, action, context, board, item, snapshot}));
        return {...base, operationContext: context, request, sessionId: request.expectedSessionId};
    }
    if (action === 'analyze') {const request = await preparationStage(options, base.id, 'session', () => options.adapter.prepareAnalysis({id: base.id, board, item, snapshot})); return {...base, request, sessionId: request.expectedSessionId};}
    const binding = settings.bindings[action]; requireValue(binding, 'OPERATION_FLOW_REQUIRED');
    const target = automationTarget(binding, await options.catalog()); requireValue(target.kind === 'flow', 'OPERATION_FLOW_REQUIRED');
    return {...base, input: {title: item.title, request: {expectedSessionId: base.id, expectedBranch: 'main', target: {kind: target.kind, id: target.id, version: target.version},
        expectedTarget: target, source: {kind: 'composer', text: '', attachments: [], values: {context: JSON.stringify({schema: 'nestos.kanban.operation/1', operationId: base.id,
            action, boardId: board.id, itemId: item.id, sourceVersion: snapshot.sourceVersion, targetVersion: snapshot.targetVersion, resources: snapshot.context, input: context})}},
        submission: {id: base.id, source: {kind: 'conversation', ownerId: base.id, id: base.id}}}}};
}
async function preparationStage<T>(options: ReviewOperationsOptions, operationId: string, stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
        const result = await work();
        options.log({operationId, stage: 'prepare.' + stage, result: 'success', durationMs: Date.now() - started}); return result;
    } catch (cause) {
        const detail=cause as {remoteCode?:string;code?:string;outcome?:string};
        const error=stage==='snapshot'&&['EBUSY','PROCESS_READERS_BUSY'].includes(detail.remoteCode??detail.code??'')&&detail.outcome==='not-committed'
            ?Object.assign(new Error('OPERATION_WORKSPACE_BUSY'),{code:'OPERATION_WORKSPACE_BUSY',outcome:'not-committed',cause}):cause;
        options.log({operationId, stage: 'prepare.' + stage, result: 'failure', code: safeCode(error, 'OPERATION_PREPARATION_FAILED'), durationMs: Date.now() - started}); throw error;
    }
}
export async function advanceReviewJob(options:ReviewOperationsOptions,job:ReviewJob,observeOnly=false):Promise<ReviewJob> {
    if(pendingCancellation(await options.journal.get<ReviewCancellation>(cancellationKey(job.id))))return (await options.journal.get<ReviewJob>(jobKey(job.id)))??job;
    const rejected=await settleRejectedMerge({...options,policy:developmentAnalysisPolicy},job);if(rejected)return rejected;
    const resource=(job.snapshot.context as {worktreeId?:string})?.worktreeId;if(resource)await indexResourceJob(options.journal,resource,'review',job.id);
    if(job.action==='accept')return acceptReview(options,job);
    return coordinateOperation({observeOnly,service:options.service,journal:options.journal,key:jobKey(job.id),record:job,port:{
        start:async record=>{requireValue(!blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(record.id))),'OPERATION_CANCELLING');const board=await options.service.read(record.boardId);
            if(board.executionControl?.paused)throw Object.assign(new Error('Delivery paused before admission'),{code:'AUTOMATIC_DELIVERY_PAUSED',executionOutcome:'not-started',retryable:true});
            requireValue(!board.lifecycle,'BOARD_STOPPING');
            const {item,archive}=await options.service.item(record.boardId,record.itemId);requireValue(!archive,'ITEM_ARCHIVED');requireValue(!item.deletedAt&&item.status!=='cancelled'&&item.control?.action!=='cancel','TASK_CANCELLING');
            await revalidateMergeAdmission({...options,policy:developmentAnalysisPolicy},record);
            if(record.managed){await options.adapter.managed!.submit(record.managed);return;}if(record.request)await options.submission.start(record.request);else await options.published.start(record.input!);},
        inspect:async record=>{
            if(blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(record.id))))return {state:'unknown' as const,code:'OPERATION_CANCELLING'};
            return inspectReview(options,record);
        },validate:(record,output)=>validateReview(options,record,output),classify:reviewFailure,report:options.report}});
}
export const replacementMismatchCode='OPERATION_RESULT_RUNNING_VERSION_MISMATCH';
export function replacementTarget(job:ReviewJob):string|undefined {
    if(job.action!=='deploy')return;
    if(job.managed)return job.managed.targetVersion;
    if(job.request)return (job.operationContext as {version?:string}|undefined)?.version;
    const source=job.input?.request.source;
    if(source?.kind==='composer'&&typeof source.values.context==='string')return JSON.parse(source.values.context).input?.version;
}
function replacementMismatch(expected:string|undefined,running:string|undefined) {
    return Object.assign(new Error(replacementMismatchCode),{code:replacementMismatchCode,result:{replacementVersions:{expected,running}}});
}
async function validateReview(options:ReviewOperationsOptions,record:ReviewJob,output:unknown):Promise<void> {
    const expectedVersion=replacementTarget(record);
    validateOperationResult({id:record.id,action:record.action,snapshot:record.snapshot,requireStatus:!!record.request,expectedVersion},output);
    if(record.action!=='deploy')return;
    const running=await operationRuntimeVersion(options,record.boardId,record.itemId);
    if(running!==expectedVersion)throw replacementMismatch(expectedVersion,running);
}
async function inspectReview(options:ReviewOperationsOptions,record:ReviewJob) {
    if(record.managed){
        const managed=options.adapter.managed;requireValue(managed,'OPERATION_RECOVERY_UNAVAILABLE');
        const observed=await managed.inspect(record);
        if(observed.code==='SERVICE_VERSION_MISMATCH'){
            throw replacementMismatch(replacementTarget(record),await operationRuntimeVersion(options,record.boardId,record.itemId));
        }
        return observed;
    }
    const observation=await observeReview(options,record);
    const recover=record.action==='deploy'&&record.request&&observation.state==='unknown';
    const output=(observation.state==='succeeded'||recover)&&record.request?await (options.adapter.readOperation??options.adapter.readAnalysis)(record):observation.output;
    const receipt=output as {status?:string;version?:string}|undefined;
    return {...observation,...(recover&&receipt?.status==='succeeded'&&await operationRuntimeVersion(options,record.boardId,record.itemId)===receipt.version?{state:'succeeded' as const}:{}),executionId:observation.sessionId,output};
}
/** Revalidate a settled mismatch against the original receipt without submitting a switch. */
export async function recheckReplacement(options:ReviewOperationsOptions,job:ReviewJob):Promise<ReviewJob> {
    requireValue(job.action==='deploy'&&job.phase==='settled'&&job.code===replacementMismatchCode,'OPERATION_RECOVERY_UNAVAILABLE');
    requireValue(!blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(job.id))),'OPERATION_CANCELLING');
    let next:ReviewJob;
    try {
        const observation=await inspectReview(options,job);
        requireValue(observation.state==='succeeded'&&observation.output!==undefined,'OPERATION_RESULT_PENDING');
        await validateReview(options,job,observation.output);
        next={...job,state:'succeeded',code:undefined,result:observation.output};
    }catch(error){
        if(safeCode(error,'OPERATION_OBSERVATION_FAILED')!==replacementMismatchCode)throw error;
        next={...job,result:(error as {result:unknown}).result};
    }
    const saved=await options.journal.update<ReviewJob>(jobKey(job.id),current=>{
        requireValue(current?.fingerprint===job.fingerprint,'OPERATION_IDENTITY_CONFLICT');
        return current.code===replacementMismatchCode?next:current;
    });
    await options.report?.(saved);
    return saved;
}
function reviewFailure(error:unknown):import('@nestos/kanban/integration').KanbanOperationFailure {
    const code=safeCode(error,safeCode((error as {cause?:unknown})?.cause,'OPERATION_OBSERVATION_FAILED')),receipt=error as {executionOutcome?:string;retryable?:boolean;result?:unknown};
    const unstarted=receipt?.executionOutcome==='not-started';
    const retry=unstarted&&receipt.retryable===true;
    const terminal=['FILE_EXCHANGE_SCOPE_INVALID','FILE_EXCHANGE_REQUEST_CHANGED','FILE_EXCHANGE_RESPONSE_CHANGED','FILE_EXCHANGE_RESULT_CONFLICT','FILE_EXCHANGE_LIMIT','FILE_EXCHANGE_CONTEXT_CHANGED'].includes(code)
        ||unstarted&&!retry||code.startsWith('OPERATION_RESULT_')||code.startsWith('MERGE_PLAN_')||code.startsWith('OPERATION_SOURCE_CHANGED')||code==='OPERATION_RUNNING_VERSION_MISMATCH';
    return {code,disposition:retry?'retry-unstarted':terminal?'terminal':'unknown',result:receipt?.result};
}
async function observeReview(options: ReviewOperationsOptions, job: ReviewJob) {
    if (!job.request) return options.published.inspect(job.input!);
    let row = await observeStage(options,job,'submission',()=>options.submission.inspect(job.request!));
    if (options.adapter.exchange) row = await observeStage(options,job,'channel',()=>options.adapter.exchange!(job, row));
    return {state: row.outcome === 'cancelled' ? 'failed' as const : row.outcome, sessionId: row.sessionId, code: row.code, output: undefined};
}
async function observeStage<T>(options:ReviewOperationsOptions,job:ReviewJob,stage:string,work:()=>Promise<T>):Promise<T> {
    const started=Date.now();
    try{return await work();}catch(error){
        options.log({operationId:job.id,stage:'operation.observe.'+stage,result:'failure',code:safeCode(error,'OPERATION_OBSERVATION_FAILED'),durationMs:Date.now()-started});throw error;
    }
}
async function acceptReview(options: ReviewOperationsOptions, job: ReviewJob): Promise<ReviewJob> {
    const {item} = await options.service.item(job.boardId, job.itemId), command = job.command;
    requireValue(command?.type === 'accept-execution'||job.scopeId&&Array.isArray(job.commands), 'OPERATION_REQUEST_INVALID');
    const accepted = command?.type==='accept-execution'&& (await options.service.workflow(job.boardId)).dispatches[command.dispatchId]?.outcome === 'accepted';
    if (!(item.status === 'completed' && accepted)) {
        const current = await options.adapter.snapshot(await options.service.read(job.boardId), item);
        const code = current.version !== job.snapshot.version ? 'OPERATION_SOURCE_CHANGED_REBUILD'
            : job.acceptanceScope!=='source'&&await operationRuntimeVersion(options,job.boardId,job.itemId) !== job.acceptanceVersion ? 'OPERATION_RUNNING_VERSION_MISMATCH' : undefined;
        if (code) return save(options, job, {...job, phase: 'settled', state: 'failed', code});
        // Acceptance evidence is committed with delivery only after the submission stage settles.
    }
    return save(options, job, {...job, phase: 'settled', state: 'succeeded'});
}
async function save(options: ReviewOperationsOptions, previous: ReviewJob, next: ReviewJob): Promise<ReviewJob> {
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous;
    const saved = await options.journal.update<ReviewJob>(jobKey(previous.id), current => {
        requireValue(current?.fingerprint === previous.fingerprint, 'OPERATION_IDENTITY_CONFLICT');
        return current.phase === 'settled' ? current : next;
    });
    await options.report?.(saved); return saved;
}

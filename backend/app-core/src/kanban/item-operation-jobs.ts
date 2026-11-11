import {invalidateReviewAnalysis,revalidateMergeAdmission} from './item-operation-analysis';
import {cancellationKey,pendingCancellation,blocksOperation,type ReviewCancellation} from './item-operation-cancellation';
import {validateOperationResult} from '@nestos/git-delivery/results';
import {indexResourceJob} from './resource-operation-index';
import {coordinateOperation} from '@nestos/kanban/integration';
import type {KanbanBoard, KanbanItem, KanbanItemOperationRequest} from '@nestos/kanban/contracts';
import {sha256HexSync} from '@nestos/common';
import {automationTarget} from './automation-targets';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';
import {jobKey, type ReviewJob, type ReviewOperationsOptions, type ReviewSettings, type ReviewAction} from './item-operation-types';

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
            if(analysis)await invalidateReviewAnalysis(options,board.id,item.id,analysis.id,code,request.operationId);requireValue(false,code);
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
export async function advanceReviewJob(options:ReviewOperationsOptions,job:ReviewJob):Promise<ReviewJob> {
    if(pendingCancellation(await options.journal.get<ReviewCancellation>(cancellationKey(job.id))))return (await options.journal.get<ReviewJob>(jobKey(job.id)))??job;
    const resource=(job.snapshot.context as {worktreeId?:string})?.worktreeId;if(resource)await indexResourceJob(options.journal,resource,'review',job.id);
    if(job.action==='accept')return acceptReview(options,job);
    return coordinateOperation({service:options.service,journal:options.journal,key:jobKey(job.id),record:job,port:{
        start:async record=>{requireValue(!blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(record.id))),'OPERATION_CANCELLING');const board=await options.service.read(record.boardId);
            if(board.executionControl?.paused)throw Object.assign(new Error('Delivery paused before admission'),{code:'AUTOMATIC_DELIVERY_PAUSED',executionOutcome:'not-started',retryable:true});
            requireValue(!board.lifecycle,'BOARD_STOPPING');
            const {item}=await options.service.item(record.boardId,record.itemId);requireValue(!item.deletedAt&&item.control?.action!=='cancel','TASK_CANCELLING');
            await revalidateMergeAdmission(options,record);
            if(record.managed){await options.adapter.managed!.submit(record.managed);return;}if(record.request)await options.submission.start(record.request);else await options.published.start(record.input!);},
        inspect:async record=>{
            if(blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(record.id))))return {state:'unknown' as const,code:'OPERATION_CANCELLING'};
            if(record.managed)return options.adapter.managed!.inspect(record);
            const observation=await observeReview(options,record);
            const recoverReplacement=record.action==='deploy'&&record.request&&observation.state==='unknown';
            const output=(observation.state==='succeeded'||recoverReplacement)&&record.request?await (options.adapter.readOperation??options.adapter.readAnalysis)(record):observation.output;
            const receipt=output as {status?:string;version?:string}|undefined;
            return {...observation,...(recoverReplacement&&receipt?.status==='succeeded'&&options.adapter.runningVersion?.()===receipt.version?{state:'succeeded' as const}:{}),executionId:observation.sessionId,output};
        },validate:(record,output)=>{
            const expectedVersion=record.action==='deploy'?(record.request||record.managed?(record.operationContext as {version:string}).version
                :JSON.parse((record.input!.request.source as {values:Record<string,string>}).values.context).input.version):undefined;
            validateOperationResult({id:record.id,action:record.action,snapshot:record.snapshot,requireStatus:!!record.request,expectedVersion},output);
            if(record.action==='deploy')requireValue(options.adapter.runningVersion?.()===(output as {version:string}).version,'OPERATION_RESULT_RUNNING_VERSION_MISMATCH');
        },classify:reviewFailure,report:options.report}});
}
function reviewFailure(error:unknown):import('@nestos/kanban/integration').KanbanOperationFailure {
    const code=safeCode(error,'OPERATION_OBSERVATION_FAILED'),receipt=error as {executionOutcome?:string;retryable?:boolean;result?:unknown};
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
            : job.acceptanceScope!=='source'&&options.adapter.runningVersion?.() !== job.acceptanceVersion ? 'OPERATION_RUNNING_VERSION_MISMATCH' : undefined;
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

import {coordinateOperation} from '@nestos/kanban/integration';
import type {KanbanBoard, KanbanItem, KanbanItemOperationRequest} from '@nestos/kanban/contracts';
import {sha256HexSync} from '@nestos/common';
import {automationTarget} from './automation-targets';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';
import {journalCommand} from '@nestos/kanban/integration';
import {jobKey, type ReviewJob, type ReviewOperationsOptions, type ReviewSettings, type ReviewAction, type MergePlan} from './item-operation-types';

export async function prepareReviewJob(options: ReviewOperationsOptions, board: KanbanBoard, item: KanbanItem,
    settings: ReviewSettings, request: KanbanItemOperationRequest, context?: unknown): Promise<ReviewJob> {
    const snapshot = await options.adapter.snapshot(board, item), action = request.action as ReviewAction;
    const base: ReviewJob = {id: request.operationId, boardId: board.id, itemId: item.id, action, snapshot,
        fingerprint: sha256HexSync(JSON.stringify(request)), phase:'prepared',state:'running',createdAt:Date.now(),...(request.followUp==='deploy'?{followUp:{action:'deploy' as const,state:'queued' as const}}:{})};
    if (action === 'deploy' || action === 'merge') {
        const evidence = context as {sourceVersion?: string; targetVersion?: string};
        requireValue(evidence?.sourceVersion === snapshot.sourceVersion && evidence.targetVersion === snapshot.targetVersion, 'OPERATION_SOURCE_CHANGED_REANALYZE');
    }
    if(action==='deploy'&&options.adapter.managed){const managed=await options.adapter.managed.prepare({id:base.id,board,item,snapshot,context});if(managed)return {...base,operationContext:context,managed};}
    if (options.adapter.prepareOperation) {
        requireValue(action !== 'accept', 'OPERATION_REQUEST_INVALID');
        const request = await options.adapter.prepareOperation({id: base.id, action, context, board, item, snapshot});
        return {...base, operationContext: context, request, sessionId: request.expectedSessionId};
    }
    if (action === 'analyze') {const request = await options.adapter.prepareAnalysis({id: base.id, board, item, snapshot}); return {...base, request, sessionId: request.expectedSessionId};}
    const binding = settings.bindings[action]; requireValue(binding, 'OPERATION_FLOW_REQUIRED');
    const target = automationTarget(binding, await options.catalog()); requireValue(target.kind === 'flow', 'OPERATION_FLOW_REQUIRED');
    return {...base, input: {title: item.title, request: {expectedSessionId: base.id, expectedBranch: 'main', target: {kind: target.kind, id: target.id, version: target.version},
        expectedTarget: target, source: {kind: 'composer', text: '', attachments: [], values: {context: JSON.stringify({schema: 'nestos.kanban.operation/1', operationId: base.id,
            action, boardId: board.id, itemId: item.id, sourceVersion: snapshot.sourceVersion, targetVersion: snapshot.targetVersion, resources: snapshot.context, input: context})}},
        submission: {id: base.id, source: {kind: 'conversation', ownerId: base.id, id: base.id}}}}};
}
export async function advanceReviewJob(options:ReviewOperationsOptions,job:ReviewJob):Promise<ReviewJob> {
    if(job.action==='accept')return acceptReview(options,job);
    return coordinateOperation({service:options.service,journal:options.journal,key:jobKey(job.id),record:job,port:{
        start:async record=>{if(record.managed){await options.adapter.managed!.submit(record.managed);return;}if(record.request)await options.submission.start(record.request);else await options.published.start(record.input!);},
        inspect:async record=>{
            if(record.managed)return options.adapter.managed!.inspect(record);
            const observation=await observeReview(options,record);
            const recoverReplacement=record.action==='deploy'&&record.request&&observation.state==='unknown';
            const output=(observation.state==='succeeded'||recoverReplacement)&&record.request?await (options.adapter.readOperation??options.adapter.readAnalysis)(record):observation.output;
            const receipt=output as {status?:string;version?:string}|undefined;
            return {...observation,...(recoverReplacement&&receipt?.status==='succeeded'&&options.adapter.runningVersion?.()===receipt.version?{state:'succeeded' as const}:{}),executionId:observation.sessionId,output};
        },validate:(record,output)=>{
            validateOperationResult(record,output);
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
    let row = await options.submission.inspect(job.request);
    if (options.adapter.exchange) row = await options.adapter.exchange(job, row);
    return {state: row.outcome === 'cancelled' ? 'failed' as const : row.outcome, sessionId: row.sessionId, code: row.code, output: undefined};
}
async function acceptReview(options: ReviewOperationsOptions, job: ReviewJob): Promise<ReviewJob> {
    const {item} = await options.service.item(job.boardId, job.itemId), command = job.command!;
    requireValue(command.type === 'accept-execution', 'OPERATION_REQUEST_INVALID');
    const accepted = (await options.service.workflow(job.boardId)).dispatches[command.dispatchId]?.outcome === 'accepted';
    if (!(item.status === 'completed' && accepted)) {
        const current = await options.adapter.snapshot(await options.service.read(job.boardId), item);
        const code = current.version !== job.snapshot.version ? 'OPERATION_SOURCE_CHANGED_REBUILD'
            : options.adapter.runningVersion?.() !== job.acceptanceVersion ? 'OPERATION_RUNNING_VERSION_MISMATCH' : undefined;
        if (code) return save(options, job, {...job, phase: 'settled', state: 'failed', code});
        await journalCommand(options.journal, options.service, job.boardId, 'review-accept:' + job.id, command);
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
function validateOperationResult(job: ReviewJob, output: unknown): void {
    const value = output as {schema?: string; operationId?: string; sourceVersion?: string; targetVersion?: string; version?: string};
    if (job.action === 'analyze') {validateMergePlan(output, job); return;}
    requireValue(value?.schema === 'nestos.kanban.operation-result/1' && value.operationId === job.id, 'OPERATION_RESULT_INVALID');
    requireValue(value.sourceVersion === job.snapshot.sourceVersion && value.targetVersion === job.snapshot.targetVersion, 'OPERATION_RESULT_SCOPE_MISMATCH');
    const agent = output as {status?: string; summary?: string};
    if (job.request) requireValue(['succeeded', 'blocked', 'failed'].includes(agent.status ?? ''), 'OPERATION_RESULT_INVALID');
    if (agent.status === 'blocked' || agent.status === 'failed') {
        requireValue(typeof agent.summary === 'string' && agent.summary.length <= 8000, 'OPERATION_RESULT_INVALID');
        throw Object.assign(new Error('Agent operation did not complete'), {code: agent.status === 'blocked' ? 'OPERATION_RESULT_AGENT_BLOCKED' : 'OPERATION_RESULT_AGENT_FAILED', result: output});
    }
    if (job.action === 'build' || job.action === 'deploy') requireValue(typeof value.version === 'string' && /^[\w.+-]{1,128}$/.test(value.version), 'OPERATION_RESULT_VERSION_REQUIRED');
    if (job.action === 'deploy') requireValue(value.version === (job.request || job.managed ? (job.operationContext as {version: string}).version : JSON.parse((job.input!.request.source as {values: Record<string, string>}).values.context).input.version), 'OPERATION_RESULT_VERSION_MISMATCH');
}
export function validateMergePlan(value: unknown, job: ReviewJob): asserts value is MergePlan {
    const plan = value as MergePlan;
    requireValue(plan && plan.sourceVersion === job.snapshot.sourceVersion && plan.targetVersion === job.snapshot.targetVersion
        && typeof plan.summary === 'string' && plan.summary.length <= 8000 && Array.isArray(plan.conflicts) && plan.conflicts.length <= 100, 'MERGE_PLAN_INVALID');
    const ids = new Set<string>();
    for (const conflict of plan.conflicts) {
        requireValue(/^[\w.-]{1,128}$/.test(conflict.id) && !['__proto__', 'constructor', 'prototype'].includes(conflict.id) && !ids.has(conflict.id) && typeof conflict.path === 'string' && conflict.path.length <= 4096
            && typeof conflict.reason === 'string' && conflict.reason.length <= 4000 && Array.isArray(conflict.options) && conflict.options.length > 0 && conflict.options.length <= 8, 'MERGE_PLAN_CONFLICT_INVALID');
        ids.add(conflict.id); const options = new Set<string>();
        for (const option of conflict.options) {
            requireValue(/^[\w.-]{1,128}$/.test(option.id) && !options.has(option.id) && typeof option.label === 'string' && option.label.length <= 256
                && (option.detail === undefined || typeof option.detail === 'string' && option.detail.length <= 4000), 'MERGE_PLAN_OPTION_INVALID'); options.add(option.id);
        }
    }
}

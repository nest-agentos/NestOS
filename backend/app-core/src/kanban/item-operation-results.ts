import type {ReviewJob,MergePlan} from './item-operation-types';
import {requireValue} from './validation';

/** Development output schemas and deployment evidence belong to the host. */
export function validateOperationResult(job: ReviewJob, output: unknown): void {
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

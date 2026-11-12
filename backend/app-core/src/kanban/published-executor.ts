import type {IndependentCallService} from '@nestos/llm-session';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {TargetRef, DagRunSpec} from '@nestos/llm-flow/contracts';
import {nodeOutputEntries} from '@nestos/llm-flow/contracts';
import type {IndependentCallExecutionReader} from '@nestos/llm-session';
import type {KanbanDiscoveryChange, KanbanScanConnection, KanbanScanInput} from '@nestos/kanban/contracts';
import type {KanbanScanExecutor} from '@nestos/kanban/discovery';
import {requireValue} from './validation';
import {KanbanError} from '@nestos/kanban';
import {KanbanScanNotStartedError} from '@nestos/kanban/discovery';

interface PublishedOptions {
    calls: IndependentCallService; execution:Pick<IndependentCallExecutionReader,'wait'|'settled'>; target: TargetRef;
    /** Prepare an isolated scanner Session, excluded by the project's source catalog. */
    prepareSession(runId: string): Promise<string>;
}
export function createPublishedKanbanExecutor(options: PublishedOptions): KanbanScanExecutor {
    requireValue(options.target.kind === 'flow', 'SCANNER_FLOW_REQUIRED');
    const target = structuredClone(options.target);
    return {identity: JSON.stringify(target), settled: input => hasSettled(options, input), async run(input) {
        const sessionId = await options.prepareSession(input.runId);
        const request: IndependentCallInput = {title: 'Kanban discovery', request: {
            expectedSessionId: sessionId, expectedBranch: 'main', expectedTarget: target,
            target: {kind: target.kind, id: target.id, version: target.version},
            source: {kind: 'composer', text: JSON.stringify(input), attachments: [], values: {}},
            ...(input.connection.kind === 'local' ? {overrides: {connectionId: input.connection.connectionId, flowConnectionBindings: {analysis: input.connection.connectionId}}} : {}),
            submission: {id: input.runId, source: {kind: 'conversation', ownerId: sessionId, id: input.runId}},
        }};
        try {
            const prepared = await options.calls.prepareTaskCall(request, {maxDepth: 4, timeoutMs: 120000});
            verifyScanPlan(prepared.plan.task, input.connection);
        } catch (error) {throw new KanbanScanNotStartedError(error instanceof KanbanError ? error.code : 'SCANNER_PREPARATION_FAILED');}
        const admission = await options.calls.submitPreparedTaskCall(request);
        const result=await options.execution.wait(admission,150000);
        requireValue(result.outcome==='succeeded','SCANNER_FLOW_FAILED');
        return parseOutput(result.output);
    }};
}
function parseOutput(output: unknown): KanbanDiscoveryChange[] | import('@nestos/kanban/contracts').KanbanDiscoveryResult {
    const returned = (output as {nodes?: Record<string, unknown>})?.nodes?.__flow_return;
    requireValue(returned, 'SCANNER_RETURN_MISSING');
    const entries = nodeOutputEntries(returned);
    const value = entries.find(e => e.name === 'changes')?.value;
    let decoded: unknown;
    try {decoded = typeof value === 'string' ? JSON.parse(value) : value;}
    catch {requireValue(false, 'INVALID_SCAN_OUTPUT');}
    const changes = (decoded as {changes?: unknown})?.changes;
    requireValue(Array.isArray(changes), 'INVALID_SCAN_OUTPUT');
    const records = (decoded as {records?: unknown})?.records;
    requireValue(records === undefined || Array.isArray(records), 'INVALID_SCAN_OUTPUT');
    return records === undefined ? changes as KanbanDiscoveryChange[] : {changes: changes as KanbanDiscoveryChange[], records: records as import('@nestos/kanban/contracts').KanbanRecordInput[]};
}

function verifyScanPlan(value: unknown, connection: KanbanScanConnection): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: DagRunSpec}}};
    requireValue(task.program?.kind === 'flow.aggregate', 'SCANNER_FLOW_REQUIRED');
    const nodes = task.input?.initialScheduler?.spec?.nodes;
    requireValue(nodes?.length && nodes.length <= 8, 'SCANNER_PLAN_LIMIT');
    let models = 0;
    for (const node of nodes) {
        requireValue(['builtin.agent', 'builtin.return', 'builtin.transform'].includes(node.plugin), 'SCANNER_PLAN_UNSUPPORTED');
        if (node.plugin !== 'builtin.agent') continue;
        models++;
        const config = node.config as {execution?: {kind: string; connectionId: string}; connectionId?: string; toolIds?: unknown[]; delegation?: unknown; subtasks?: unknown};
        requireValue(!config.toolIds?.length && !config.delegation && !config.subtasks, 'SCANNER_TOOLS_FORBIDDEN');
        if (connection.kind === 'remote') requireValue(config.execution?.kind === 'harness' && config.execution.connectionId === connection.connectionId, 'SCANNER_CONNECTION_MISMATCH');
        else requireValue(config.execution?.kind !== 'harness' && config.connectionId === connection.connectionId, 'SCANNER_CONNECTION_MISMATCH');
    }
    requireValue(models === 1, 'SCANNER_MODEL_COUNT');
}

async function hasSettled(options: PublishedOptions, input: KanbanScanInput): Promise<boolean> {
    const sessionId = await options.prepareSession(input.runId);
    return options.execution.settled(sessionId);
}

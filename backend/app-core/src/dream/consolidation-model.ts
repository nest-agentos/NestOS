import {createModuleLogger, randomUUID, sha256HexSync} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {IndependentCallService, SessionRepository} from '@nestos/llm-session';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {Kernel, TaskCallResult} from '@nestos/durable-kernel';
import type {TargetRef, DagRunSpec} from '@nestos/llm-flow/contracts';
import {scannerOutput} from '../digital-twin/scanner-executor';
import type {ConsolidationModel, ProposalDraft} from './consolidation';
import {buildConsolidationPrompt} from '@nestos/dream';

interface Options {
    fs: IFileSystem; path: string; target: TargetRef; repository: Pick<SessionRepository, 'ensureSession'>;
    calls: Pick<IndependentCallService, 'prepareTaskCall' | 'submitPreparedTaskCall' | 'inspectTaskCallSubmission'>;
    kernel: Pick<Kernel, 'attachTask'>;
    bindSession(sessionId: string, scopes: readonly string[]): Promise<void>;
    authorize(scopes: readonly string[]): Promise<void>;
}
const log = createModuleLogger('dream-consolidation-model');

/** Durable admission uses one persisted Session and submission identity for each operation. */
export class PublishedConsolidationModel implements ConsolidationModel {
    constructor(private readonly options: Options) {
        if (options.target.kind !== 'flow') throw new Error('DREAM_CONSOLIDATION_TARGET_INVALID');
    }

    async run(input: Parameters<ConsolidationModel['run']>[0]): Promise<ProposalDraft[]> {
        const started = Date.now();
        const text = buildConsolidationPrompt(input);
        const sessionId = await this.session(input.operationId, sha256HexSync(JSON.stringify([this.options.target, text])));
        const request = this.request(input.operationId, sessionId, text);
        await this.options.authorize(input.requiredScopes);
        await this.options.bindSession(sessionId, input.requiredScopes);
        await this.options.repository.ensureSession(sessionId, 'Dream consolidation');
        log.info('dream.consolidation.model', {operationId: input.operationId, stage: 'admission', result: 'started', durationMs: Date.now() - started});
        let admission = await this.options.calls.inspectTaskCallSubmission(request);
        if (!admission) {
            const prepared = await this.options.calls.prepareTaskCall(request, {maxDepth: 4, timeoutMs: 120000});
            assertPlan(prepared.plan.task);
            log.info('dream.consolidation.model', {operationId: input.operationId, stage: 'prepared', result: 'success', durationMs: Date.now() - started});
            await this.options.bindSession(prepared.executionSessionId, input.requiredScopes);
            await this.options.authorize(input.requiredScopes);
            try {admission = await this.options.calls.submitPreparedTaskCall(request);}
            catch (error) {
                admission = await this.options.calls.inspectTaskCallSubmission(request);
                if (!admission) throw error;
            }
        }
        await this.options.bindSession(admission.executionSessionId, input.requiredScopes);
        await this.options.authorize(input.requiredScopes);
        log.info('dream.consolidation.model', {operationId: input.operationId, stage: 'wait', result: 'started', durationMs: Date.now() - started});
        const handle = await this.options.kernel.attachTask(admission.submission.task.sessionId, admission.submission.task.taskId);
        const exit = await handle.wait({until: 'settled', timeoutMs: 150000});
        const result = exit.output as TaskCallResult | undefined;
        if (exit.status !== 'succeeded' || result?.exit.status !== 'succeeded') throw new Error('DREAM_CONSOLIDATION_EXECUTION_FAILED');
        await this.options.authorize(input.requiredScopes);
        return parseOutput(scannerOutput(result.exit.output));
    }

    private async session(operationId: string, fingerprint: string): Promise<string> {
        return this.options.fs.meta.seq!.transaction!(async tx => {
            const key = `consolidation-call:${JSON.stringify(operationId)}`, raw = await tx.getEntry(this.options.path, key);
            if (raw) {
                const saved = JSON.parse(raw) as {fingerprint: string; sessionId: string};
                if (saved.fingerprint !== fingerprint || !saved.sessionId) throw new Error('DREAM_OPERATION_CONFLICT');
                return saved.sessionId;
            }
            const sessionId = randomUUID();
            await tx.setEntry(this.options.path, key, JSON.stringify({fingerprint, sessionId}));
            return sessionId;
        });
    }

    private request(operationId: string, sessionId: string, text: string): IndependentCallInput {
        const target = this.options.target;
        return {title: 'Dream consolidation', request: {expectedSessionId: sessionId, expectedBranch: 'main', expectedTarget: target,
            target: {kind: target.kind, id: target.id, version: target.version}, source: {kind: 'composer', text, attachments: [], values: {}},
            submission: {id: operationId, source: {kind: 'conversation', ownerId: sessionId, id: operationId}}}};
    }
}

function assertPlan(value: unknown): void {
    const task = value as {program?: {kind?: string}; input?: {initialScheduler?: {spec?: DagRunSpec}}};
    if (task.program?.kind !== 'flow.aggregate') throw new Error('DREAM_CONSOLIDATION_PLAN_INVALID');
    const graph = task.input?.initialScheduler?.spec;
    if (!graph || graph.functionCalls && Object.keys(graph.functionCalls).length || graph.nodes.length > 8) throw new Error('DREAM_CONSOLIDATION_PLAN_INVALID');
    let models = 0;
    for (const node of graph.nodes) {
        if (!['builtin.agent', 'builtin.return', 'builtin.transform'].includes(node.plugin)) throw new Error('DREAM_CONSOLIDATION_PLAN_INVALID');
        if (node.plugin === 'builtin.agent') {
            models++;
            const config = node.config as {toolIds?: unknown[]; delegation?: unknown; subtasks?: unknown; execution?: {kind?: string}};
            if (config?.toolIds?.length || config?.delegation || config?.subtasks || config?.execution?.kind === 'harness')
                throw new Error('DREAM_CONSOLIDATION_PLAN_INVALID');
        }
    }
    if (models !== 1) throw new Error('DREAM_CONSOLIDATION_PLAN_INVALID');
}

function parseOutput(output: unknown): ProposalDraft[] {
    let value: unknown;
    try {value = typeof output === 'string' ? JSON.parse(output) : output;} catch {throw new Error('DREAM_CONSOLIDATION_OUTPUT_INVALID');}
    const proposals = (value as {proposals?: unknown})?.proposals;
    if (!Array.isArray(proposals) || proposals.length > 32) throw new Error('DREAM_CONSOLIDATION_OUTPUT_INVALID');
    return proposals as ProposalDraft[];
}

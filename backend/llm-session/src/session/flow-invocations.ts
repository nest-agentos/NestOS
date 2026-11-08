import type { JsonValue, DagRunSpec } from '@nestos/llm-flow/contracts';
import {assertRootCallable, isTargetRef, sameTargetRef} from '@nestos/llm-flow/contracts';
import {flowTargetRef} from './flow-target';
import type { ICommandBus } from '../contracts';
import type { Kernel, SessionHandle } from '@nestos/durable-kernel';
import {simpleHash} from '@nestos/llm-context';
import { FlowCommand, FlowDefinitionStore, prepareFlowCallInput, type DagCommandService } from '@nestos/llm-flow';
import type { ContentTransferService } from './content-transfers';
import { createSessionHost, type SessionHostPorts } from '../utils/host-ports';

import { FlowInvocationCommand, flowInvocationId, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
import {FLOW_INVOCATION_PREFIX, flowInvocationRequest, assertFlowRerun, findFlowInvocationRoot} from './flow-invocation-identity';
import {ulid} from '../persistence/ulid';
export { FlowInvocationCommand, type FlowInvocationInput, type FlowInvocationRecord } from '../contracts/flow-invocations';
const PREFIX = FLOW_INVOCATION_PREFIX;
const RECOVERY_SCOPE = 'session.flow.admission';
/** Shared records already read by a caller, so recovery does not list them twice. */
type StoredInvocations = Awaited<ReturnType<Kernel['listShared']>>;

/** Calls live beside chat history; their completion never moves the conversation head. */
export class FlowInvocationService {
    private pending = new Map<string, Promise<FlowInvocationRecord>>();
    constructor(private kernel: Kernel, private definitions: FlowDefinitionStore, private commands: ICommandBus,
        private canWrite?: (id: string) => Promise<boolean>,
        private source?: (id: string) => Promise<{ branch: string; head: string | null; parentSessionId?: string }>,
        private resolveConnection?: (sessionId: string, connectionId?: string) => Promise<string | undefined>,
        private runs?: Pick<DagCommandService, 'prepareRun' | 'submitPrepared'>,
        private transfers?: Pick<ContentTransferService, 'read'> & Partial<Pick<ContentTransferService, 'createChild'>>, private hostPorts?: SessionHostPorts) {}

    register(): void {
        this.commands.register(FlowInvocationCommand.Invoke, args => this.invoke(args as FlowInvocationInput));
        this.commands.register(FlowInvocationCommand.List, args => this.list((args as { sessionId: string }).sessionId));
    }

    async invoke(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        input = flowInvocationRequest(input);
        const key = `${input.sessionId}/${input.requestId}`;
        const previous = this.pending.get(key);
        if (previous) { const record = await previous; this.assertSame(record, input); return record; }
        const operation = this.traceAdmission(structuredClone(input));
        this.pending.set(key, operation);
        try { return await operation; } finally { this.pending.delete(key); }
    }

    async list(sessionId: string, stored?: StoredInvocations): Promise<FlowInvocationRecord[]> {
        const entries = stored ?? await this.kernel.listShared(sessionId, PREFIX);
        if (entries.length === 0) return [];
        const session = await this.kernel.inspectSession(sessionId);
        const tasks = await session.listTasks();
        return (await Promise.all(entries.map(async entry => {
            const record = entry.value as unknown as FlowInvocationRecord;
            this.assertIdentity(record, sessionId);
            const executionTasks = record.executionSessionId
                ? await (await this.kernel.inspectSession(record.executionSessionId)).listTasks() : tasks;
            const root = findFlowInvocationRoot(executionTasks, record);
            const childError = !root && record.executionSessionId
                ? await this.childAdmissionError(record) : undefined;
            return { ...record, ...(root ? { rootTaskId: root.id, error: undefined } : childError ? {error: childError} : {}) };
        }))).sort((a, b) => a.createdAt - b.createdAt);
    }

    async recover(): Promise<void> {
        const candidates = await this.kernel.listRecoveryShared(RECOVERY_SCOPE), started = Date.now(), operationId = ulid();
        for (const ref of candidates) {
            if ((await this.kernel.sessionStat(ref.sessionId)).phase !== 'open') continue;
            if (this.canWrite && !await this.canWrite(ref.sessionId)) continue;
            const session = await this.kernel.inspectSession(ref.sessionId), stored = await session.getShared(ref.key);
            if (!stored) throw Object.assign(new Error('Flow recovery record missing'), {code: 'FLOW_RECOVERY_RECORD_MISSING'});
            const record = stored.value as unknown as FlowInvocationRecord;
            this.assertIdentity(record, ref.sessionId);
            if (ref.key !== PREFIX + record.requestId) throw Object.assign(new Error('Flow recovery scope mismatch'), {code: 'FLOW_RECOVERY_SCOPE_MISMATCH'});
            if (record.error || record.executionSessionId && await this.childAdmissionError(record)) {
                await this.kernel.setShared(ref.sessionId, ref.key, stored.value,
                    {expectedVersion: stored.version, recovery: {scope: RECOVERY_SCOPE, pending: false}});
                continue;
            }
            await this.invoke(record);
        }
        console.info('[FlowRecovery]', {operation: 'flow.invocations.recover', operationId, stage: 'indexed', result: 'success',
            candidateCount: candidates.length, durationMs: Date.now() - started});
    }

    private async submit(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        await this.assertWritable(input.sessionId);
        if (input.execution === 'child' && !this.transfers?.createChild) throw new Error('Independent Flow calls are unavailable');
        const session = await this.kernel.openSession(input.sessionId), key = PREFIX + input.requestId;
        let record = await this.admit(input, session);
        if (record.execution === 'child') return this.submitChild(session, record);
        const existing = findFlowInvocationRoot(await session.listTasks(), record);
        if (existing) return this.saveRoot(session, record, existing.id);
        // Upgrade older intents only when no durable root already owns their graph.
        if (this.runs && !record.preparedGraph) {
            record = await this.prepare(record);
            await session.setShared(key, json(record), {recovery: {scope: RECOVERY_SCOPE, pending: true}});
        }
        try {
            await this.assertWritable(input.sessionId);
            const { taskId } = await this.start(record);
            return await this.saveRoot(session, record, taskId);
        } catch (error) {
            const root = findFlowInvocationRoot(await session.listTasks(), record);
            if (root) return this.saveRoot(session, record, root.id);
            await session.setShared(key, json({ ...record, error: String(error) }), {recovery: {scope: RECOVERY_SCOPE, pending: false}});
            throw error;
        }
    }

    private async childAdmissionError(parent: FlowInvocationRecord): Promise<string | undefined> {
        const child = await this.kernel.inspectSession(parent.executionSessionId!);
        const stored = await child.getShared(PREFIX + parent.requestId);
        if (!stored) return;
        const record = stored.value as unknown as FlowInvocationRecord;
        this.assertIdentity(record, parent.executionSessionId!);
        if (record.invocationId !== parent.invocationId || record.callerSessionId !== parent.sessionId)
            throw new Error('Independent Flow invocation identity conflict');
        return record.error;
    }

    private async submitChild(parent: SessionHandle, record: FlowInvocationRecord): Promise<FlowInvocationRecord> {
        if (record.executionSessionId) await this.assertWritable(record.executionSessionId);
        const {sessionId} = await this.transfers!.createChild!({sessionId: parent.id, requestId: record.requestId, title: record.flow.name});
        if (record.executionSessionId && record.executionSessionId !== sessionId) throw new Error('Independent Flow Session identity conflict');
        if (!record.executionSessionId) {
            record = {...record, executionSessionId: sessionId};
            await parent.setShared(PREFIX + record.requestId, json(record), {recovery: {scope: RECOVERY_SCOPE, pending: true}});
        }
        await this.assertWritable(sessionId);
        const child = await this.kernel.openSession(sessionId);
        const input = {...record, sessionId, execution: undefined, executionSessionId: undefined,
            callerSessionId: parent.id, rootTaskId: undefined, preparedGraph: undefined,
            retryOfSessionId: record.retryOfInvocationId ? record.retryOfSessionId ?? parent.id : undefined};
        await this.saveChildIntent(child, input);
        const result = await this.submit(flowInvocationRequest(input));
        return this.saveRoot(parent, record, result.rootTaskId!);
    }

    private async saveChildIntent(child: SessionHandle, input: FlowInvocationRecord): Promise<void> {
        const key = PREFIX + input.requestId;
        let stored = await child.getShared(key);
        if (!stored) {
            const prepared = await this.prepare(input);
            try {await child.setShared(key, json(prepared), {expectedVersion: null, recovery: {scope: RECOVERY_SCOPE, pending: true}}); return;}
            catch (error) {stored = await child.getShared(key); if (!stored) throw error;}
        }
        const record = stored.value as unknown as FlowInvocationRecord;
        this.assertSame(record, input);
        if (record.invocationId !== input.invocationId || record.callerSessionId !== input.callerSessionId)
            throw new Error('Independent Flow invocation identity conflict');
    }

    private async start(record: FlowInvocationRecord): Promise<{ taskId: string }> {
        const parameters = invocationParameters(record);
        const invocation: DagRunSpec['invocation'] = { requestId: record.requestId, flowId: record.flowId,
            ...(record.target ? {target: structuredClone(record.target)} : {}),
            ...(record.invocationId ? {invocationId: record.invocationId} : {}),
            ...(record.retryOfInvocationId ? {retryOfInvocationId: record.retryOfInvocationId, retryOfSessionId: record.retryOfSessionId ?? record.sessionId} : {}),
            revision: record.flow.revision, digest: record.flow.digest, name: record.flow.name, createdAt: record.createdAt,
            ...(record.branch ? { branch: record.branch, head: record.head } : {}) };
        if (record.preparedGraph) {
            if (!this.runs) throw new Error('Admitted Flow graph requires a compiled run runtime');
            return this.runs.submitPrepared({ kind: 'graph', sessionId: record.sessionId,
                graph: { ...record.preparedGraph, invocation }, parameters });
        }
        return this.commands.execute(FlowCommand.RunStart, { sessionId: record.sessionId, flow: record.flow,
            parameters, invocation, connectionBindings: record.connectionBindings,
            connectionId: record.connectionId, fallbackConnectionId: record.resolvedConnectionId });
    }

    private async saveRoot(session: SessionHandle, record: FlowInvocationRecord, taskId: string): Promise<FlowInvocationRecord> {
        if (record.rootTaskId === taskId && !record.preparedGraph && !record.error) return record;
        const saved = { ...record, rootTaskId: taskId, error: undefined, preparedGraph: undefined };
        await session.setShared(PREFIX + record.requestId, json(saved), {recovery: {scope: RECOVERY_SCOPE, pending: false}});
        return saved;
    }

    private async prepare(record: FlowInvocationRecord): Promise<FlowInvocationRecord> {
        if (!this.runs || record.execution === 'child') return record;
        const preparedGraph = await this.runs.prepareRun({ sessionId: record.sessionId, flow: record.flow,
            parameters: invocationParameters(record), connectionId: record.connectionId, connectionBindings: record.connectionBindings,
            fallbackConnectionId: record.resolvedConnectionId ?? null });
        return { ...record, preparedGraph };
    }

    private async admit(input: FlowInvocationInput, session: SessionHandle): Promise<FlowInvocationRecord> {
        const key = PREFIX + input.requestId;
        const saved = await session.getShared(key);
        let record = saved?.value as unknown as FlowInvocationRecord | undefined;
        if (record) this.assertSame(record, input);
        else {
            record = await this.inputRecord(input);
            record = await this.prepare(record);
            try {await session.setShared(key, json(record), {expectedVersion: null, recovery: {scope: RECOVERY_SCOPE, pending: true} });}
            catch (error) {
                const winner = await session.getShared(key);
                if (!winner) throw error;
                record = winner.value as unknown as FlowInvocationRecord; this.assertSame(record, input);
            }
        }
        return record;
    }

    private async inputRecord(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        const loaded = await this.definitions.loadRevision(input.flowId, input.revision);
        if (!loaded) throw new Error(`Flow revision not found: ${input.flowId}@${input.revision}`);
        const flow = structuredClone(loaded);
        assertRootCallable(flow);
        if (input.source && Object.keys(input.parameters).length) throw new Error('Flow parameters and source cannot both be supplied');
        const inputResolution = prepareFlowCallInput(flow, input.source ?? {kind: 'arguments', value: input.parameters}, {expected: input.expectedSignature});
        const location = await this.source?.(input.sessionId);
        await assertFlowRerun(this.kernel, input, location?.parentSessionId);
        const inputTransfers = await this.bindInputs({...input, parameters: inputResolution.parameters});
        return {...input, invocationId: ulid(), target: flowTargetRef(flow), inputResolution, inputResolutionDigest: simpleHash(canonical(inputResolution)),
            ...(inputTransfers ? {inputTransfers} : {}), resolvedConnectionId: await this.resolveConnection?.(input.sessionId, input.connectionId) ?? null,
            flow, createdAt: Date.now(), ...(location ? {branch: location.branch, head: location.head} : {})};
    }

    private async bindInputs(input: FlowInvocationInput): Promise<FlowInvocationRecord['inputTransfers']> {
        if (!input.inputSources || !Object.keys(input.inputSources).length) return;
        if (!this.transfers) throw new Error('CONTENT_TRANSFER_UNAVAILABLE');
        const result: NonNullable<FlowInvocationRecord['inputTransfers']> = Object.create(null);
        for (const [name, reference] of Object.entries(input.inputSources)) {
            const transfer = await this.transfers.read(reference, input.sessionId);
            if (!Object.hasOwn(input.parameters, name) || canonical(input.parameters[name]) !== canonical(transfer.value))
                throw new Error('CONTENT_PARAMETER_MISMATCH');
            result[name] = transfer;
        }
        return result;
    }

    private async traceAdmission(input: FlowInvocationInput): Promise<FlowInvocationRecord> {
        const started = Date.now(), logger = createSessionHost(this.hostPorts).logger;
        const metadata = {operation: 'flow.invoke', stage: 'admission', sessionId: input.sessionId, operationId: input.requestId,
            flowId: input.flowId, revision: input.revision, parameterCount: Object.keys(input.parameters).length, sourceCount: Object.keys(input.inputSources ?? {}).length};
        try {
            const record = await this.submit(input);
            logger.info('Flow invocation admitted', {...metadata, outcome: 'success', taskId: record.rootTaskId,
                invocationId: flowInvocationId(record), retryOfInvocationId: record.retryOfInvocationId, executionSessionId: record.executionSessionId,
                resolvedParameterCount: Object.keys(invocationParameters(record)).length, inputSource: input.source?.kind ?? 'arguments', durationMs: Date.now() - started});
            return record;
        } catch (error) {
            const value = (error as {code?: unknown} | null)?.code;
            const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value
                : error instanceof Error && /^CONTENT_[A-Z_]+$/.test(error.message) ? error.message : 'FLOW_ADMISSION_FAILED';
            logger.error('Flow invocation admission failed', {...metadata, outcome: 'failure', errorCode: code,
                errorClass: error instanceof Error ? error.name : typeof error, durationMs: Date.now() - started});
            throw error;
        }
    }

    private assertSame(record: FlowInvocationRecord, input: FlowInvocationInput): void {
        this.assertIdentity(record, input.sessionId);
        invocationParameters(record);
        if (record.execution !== input.execution || record.requestId !== input.requestId || record.retryOfInvocationId !== input.retryOfInvocationId || record.retryOfSessionId !== input.retryOfSessionId
            || canonical(record.source ?? null) !== canonical(input.source ?? null) || canonical(record.expectedSignature ?? null) !== canonical(input.expectedSignature ?? null)
            || canonical(record.inputSources ?? {}) !== canonical(input.inputSources ?? {}) || canonical(record.connectionBindings ?? {}) !== canonical(input.connectionBindings ?? {}) || record.connectionId !== input.connectionId || record.flowId !== input.flowId || record.revision !== input.revision || canonical(record.parameters) !== canonical(input.parameters)) {
            throw new Error('Flow invocation request id was already used with different arguments');
        }
    }

    private assertIdentity(record: FlowInvocationRecord, sessionId: string): void {
        if (!record || record.sessionId !== sessionId || typeof record.requestId !== 'string' || !/^[\w-]{1,128}$/.test(record.requestId)
            || record.invocationId !== undefined && (typeof record.invocationId !== 'string' || !record.invocationId)
            || record.target !== undefined && (!isTargetRef(record.target) || !sameTargetRef(record.target, flowTargetRef(record.flow))))
            throw Object.assign(new Error('Stored Flow invocation identity is invalid'), {code: 'FLOW_INVOCATION_STORAGE_INVALID'});
    }

    private async assertWritable(sessionId: string): Promise<void> {
        if (this.canWrite && !await this.canWrite(sessionId)) throw new Error('Session is owned by another host');
        const status = await this.kernel.sessionStat(sessionId);
        if (status.phase !== 'open' || status.archived) throw new Error('Session is not open');
    }
}

function invocationParameters(record: FlowInvocationRecord): Record<string, JsonValue> {
    if (!record.inputResolution) return record.parameters;
    if (record.inputResolution.version !== 1 || record.inputResolutionDigest !== simpleHash(canonical(record.inputResolution)))
        throw Object.assign(new Error('Flow input resolution is invalid; restore the admitted snapshot'), {code: 'FLOW_INPUT_RESOLUTION_CONFLICT'});
    return record.inputResolution.parameters;
}

function json(value: unknown): JsonValue { return JSON.parse(JSON.stringify(value)); }
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return JSON.stringify(value);
}

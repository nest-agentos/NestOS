import {sha256HexSync, createModuleLogger} from '@nestos/common';
import {parseDerivedFindings, scanSources, sameAuthority, type DreamSource, type SourcePort, type SourceAuthority} from '@nestos/dream';
import type {DigitalTwinService} from '../digital-twin/service';
import type {DreamEvidenceStore, DreamFinding} from './evidence-store';
import type {Kernel, TaskCallResult} from '@nestos/durable-kernel';
import type {DreamProjectFilePort} from './project-file-source';
import {TWIN_CHUNK_CHARACTERS, TWIN_MANAGED_SOURCE_MAX_BYTES} from '../digital-twin/chunking';
import {scannerOutput} from '../digital-twin/scanner-executor';
import {parseCandidates} from '../digital-twin/extraction';

export type DreamTwinScanner = Pick<DigitalTwinService, 'dreamScanEvidence' | 'triggerScanPlan' | 'waitScanRun'>
    & Partial<Pick<DigitalTwinService, 'ensureBoundScanner' | 'saveDreamScannerSnapshot'>>;
type Twin = DreamTwinScanner;
type Snapshot = Awaited<ReturnType<Twin['dreamScanEvidence']>>;
export interface DreamTwinFileScanInput {
    ownerProjectId: string; dreamId: string; operationId: string; planId: string; planRevision: string;
    twinSourceId: string; target: string; source: DreamSource;
    sourceKind?: 'file' | 'managed-artifact';
    evidenceSourceType?: 'file' | 'session' | 'git' | 'change' | 'other';
    configRevision?: number;
}
type Input = DreamTwinFileScanInput;
const log = createModuleLogger('dream-scan');

/** A Twin event provides the stable execution identity; its committed task is verified before Dream settlement. */
export async function runDreamTwinFileScan(input: Input, twin: Twin, port: DreamProjectFilePort, store: DreamEvidenceStore,
    kernel: Pick<Kernel, 'task'>, authorizeOwner: () => Promise<void>, registerRun?: (runId: string, authority: SourceAuthority,
        retryPlan?: {sourceId: string; planId: string; revision: string}) => Promise<void>): Promise<void> {
    input = structuredClone(input);
    const started = Date.now(); let stage = 'prepare', prepared = false;
    try {
        const requestHash = sha256HexSync(JSON.stringify(input));
        await checkOwner(authorizeOwner);
        if (port.target(input.source) !== input.target) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        const existing = await store.run(input.ownerProjectId, input.dreamId, input.operationId);
        if (existing) {if (existing.requestHash !== requestHash) throw new Error('DREAM_OPERATION_CONFLICT'); return;}
        await store.prepare(input.ownerProjectId, input.dreamId, input.operationId, requestHash, input.source.id);
        prepared = true;
        const before = await twin.dreamScanEvidence(input.operationId, input.planId, input.twinSourceId); verifyPlan(before, input);
        if (input.configRevision !== undefined) await store.checkConfig(input.ownerProjectId, input.dreamId, input.configRevision);
        const saved = await store.readCapturedOperation(input.ownerProjectId, input.dreamId, input.operationId,
            captured => authorizeCaptured(input, captured, port));
        const result = saved ? capturedResult(input, saved) : await readScanSource(input.source, port);
        if (!result.items.length) {await checkOwner(authorizeOwner); await store.settle(input.ownerProjectId, input.dreamId, input.operationId, [result], [], undefined, requestHash, input.configRevision); return;}
        if (result.items.length !== 1 || (input.evidenceSourceType === 'session'
            ? new TextEncoder().encode(result.items[0]).length > TWIN_MANAGED_SOURCE_MAX_BYTES
            : result.items[0].length > TWIN_CHUNK_CHARACTERS)) throw new Error('DREAM_SOURCE_LIMIT');
        stage = 'capture';
        if (!saved) await captureSource(input, result, store);
        stage = 'execute';
        await checkOwner(authorizeOwner);
        if (input.configRevision !== undefined) await store.checkConfig(input.ownerProjectId, input.dreamId, input.configRevision);
        if (!sameAuthority(result.evidence.authority, await authorize(port, input.source))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const eventId = sha256HexSync(JSON.stringify([input.ownerProjectId, input.dreamId, input.operationId]));
        const priorRun = saved ? await store.capturedRun(input.ownerProjectId, input.dreamId, input.operationId) : null;
        const attempt = saved ? await retryAttempt(input, twin, store) : {attempt: 0, runId: null};
        if (saved && !priorRun && (await port.read({...input.source, cursor: null}, 1)).version !== result.evidence.version)
            throw new Error('DREAM_CAPTURED_EXECUTION_UNAVAILABLE');
        const retry = attempt.attempt ? await retryPlan(input, twin, before, result.items[0], attempt.attempt) : null;
        const executionInput = retry ? {...input, planId: retry.planId, planRevision: retry.revision, twinSourceId: retry.sourceId,
            target: retry.target, sourceKind: 'managed-artifact' as const} : input;
        const runId = attempt.runId ?? (retry ? null : priorRun) ?? await twin.triggerScanPlan(executionInput.planId,
            retry ? sha256HexSync(JSON.stringify([eventId, attempt.attempt])) : eventId,
            registerRun ? id => registerRun(id, result.evidence.authority, retry ?? undefined) : undefined);
        if (retry) await store.bindScanAttempt(input.ownerProjectId, input.dreamId, input.operationId, attempt.attempt, runId);
        else await store.bindCapturedRun(input.ownerProjectId, input.dreamId, input.operationId, runId);
        if (registerRun) await registerRun(runId, result.evidence.authority, retry ?? undefined);
        await twin.waitScanRun(runId);
        stage = 'verify';
        const after = await twin.dreamScanEvidence(input.operationId, executionInput.planId, executionInput.twinSourceId, runId); verifyPlan(after, executionInput);
        const jobs = verifyExecution(after, executionInput, runId, result.items[0].length, result.evidence.version, saved?.fingerprint);
        const outputs = await readJobOutputs(jobs, kernel, result.items[0]);
        const current = await authorize(port, input.source);
        if (!sameAuthority(result.evidence.authority, current)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        if (!saved) {
            const fresh = await port.read({...input.source, cursor: null}, 1);
            if (fresh.version !== result.evidence.version) throw new Error('DREAM_SOURCE_CHANGED');
        }
        const final = await authorize(port, input.source);
        if (!sameAuthority(result.evidence.authority, final)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const candidates = outputs.flatMap(output => output.candidates);
        const findings = findingsFor(after, executionInput, runId, result.items[0], !!saved).map(finding => ({...finding, sourceId: input.source.id}));
        const keys = candidates.map(candidate => JSON.stringify([candidate.content, candidate.quote, candidate.subject, candidate.project, candidate.eventTime]));
        const candidateKeys = (jobs.length > 1 ? [...new Set(keys)] : keys).sort();
        const findingKeys = findings.map(finding => JSON.stringify([finding.content, finding.quote, finding.subject, finding.project, finding.eventTime])).sort();
        if (candidates.some(candidate => candidate.kind !== 'fact' || candidate.relation !== undefined)
            || JSON.stringify(candidateKeys) !== JSON.stringify(findingKeys))
            throw new Error('DREAM_RESULT_UNSUPPORTED');
        const derived = outputs.flatMap((output, jobIndex) => parseDerivedFindings(output.parsed, output.text).map((item, index) => ({...item,
            id: 'dream-' + sha256HexSync(JSON.stringify(jobs.length === 1 ? [runId, index, item] : [runId, jobIndex, index, item])),
            sourceId: input.source.id, recordedAt: jobs[jobIndex].createdAt})));
        stage = 'settle';
        await checkOwner(authorizeOwner);
        await store.settle(input.ownerProjectId, input.dreamId, input.operationId, [result], [...findings, ...derived],
            {scanRunId: runId, sessionId: jobs[0].sessionId, taskId: jobs[0].taskId,
                ...(jobs.length > 1 ? {additionalTasks: jobs.slice(1).map(job => ({sessionId: job.sessionId, taskId: job.taskId}))} : {})}, requestHash, input.configRevision);
        log.info('dream.scan', {operationId: input.operationId, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
            : stage === 'settle' ? 'DREAM_SETTLEMENT_FAILED' : stage === 'execute' ? 'DREAM_EXECUTION_FAILED' : 'DREAM_SCAN_FAILED';
        if (prepared) await store.fail(input.ownerProjectId, input.dreamId, input.operationId, code).catch(() => {
            log.warn('dream.scan.history', {operationId: input.operationId, stage: 'failure-record', result: 'failure', code: 'DREAM_HISTORY_WRITE_FAILED', durationMs: Date.now() - started});
        });
        log.warn('dream.scan', {operationId: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId) ? input.operationId : 'invalid',
            stage, result: 'failure', code, cause: error instanceof Error && /^(TWIN|DREAM)_[A-Z_]+$/.test(error.message) ? error.message : 'OTHER', durationMs: Date.now() - started});
        throw new Error(code);
    }
}

async function retryAttempt(input: Input, twin: Twin, store: DreamEvidenceStore) {
    let current = await store.scanAttempt(input.ownerProjectId, input.dreamId, input.operationId);
    if (!current.runId) return current;
    const snapshot = await twin.dreamScanEvidence(input.operationId, input.planId, input.twinSourceId, current.runId);
    if (!snapshot.run || !['failed', 'interrupted', 'cancelled'].includes(snapshot.run.data.state)) return current;
    try {await store.advanceScanAttempt(input.ownerProjectId, input.dreamId, input.operationId, current.attempt, current.runId);}
    catch (error) {if (!(error instanceof Error) || error.message !== 'DREAM_ATTEMPT_CONFLICT') throw error;}
    current = await store.scanAttempt(input.ownerProjectId, input.dreamId, input.operationId);
    return current;
}

async function retryPlan(input: Input, twin: Twin, before: Snapshot, text: string, attempt: number) {
    if (!twin.saveDreamScannerSnapshot || !twin.ensureBoundScanner || !before.plan?.data.executor
        || !before.plan.data.maxOutputTokens || !before.plan.data.runTokenLimit) throw new Error('DREAM_CAPTURED_EXECUTION_UNAVAILABLE');
    const id = sha256HexSync(JSON.stringify([input.ownerProjectId, input.dreamId, input.operationId, attempt]));
    const target = await twin.saveDreamScannerSnapshot(text);
    const plan = await twin.ensureBoundScanner({sourceId: 'dream-retry-source-' + id, planId: 'dream-retry-plan-' + id,
        spec: {kind: 'managed-artifact', target, label: ''}, executor: before.plan.data.executor, name: 'Dream', kinds: ['fact'],
        maxOutputTokens: before.plan.data.maxOutputTokens, runTokenLimit: before.plan.data.runTokenLimit});
    return {sourceId: plan.sourceId, planId: plan.planId, revision: plan.planRevision, target};
}

async function captureSource(input: Input, result: Extract<Awaited<ReturnType<typeof readScanSource>>, {status: 'ok'}>, store: DreamEvidenceStore): Promise<void> {
    const evidence = result.evidence, snapshot = result.items[0], fingerprint = sha256HexSync(snapshot);
    await store.captureEvidence(input.ownerProjectId, input.dreamId, {
        id: 'evidence-' + sha256HexSync(JSON.stringify([evidence.version, fingerprint])), projectId: evidence.projectId,
        sourceType: input.evidenceSourceType ?? (input.sourceKind === 'managed-artifact' ? 'other' : 'file'),
        sourceId: evidence.sourceId, connectionId: evidence.connectionId, authority: evidence.authority,
        fingerprint, locator: input.target, granularity: input.sourceKind === 'managed-artifact' ? 'summary' : 'excerpt', snapshot,
        sourceVersion: evidence.version, startCursor: evidence.startCursor, endCursor: evidence.endCursor, scanned: evidence.scanned,
    }, evidence.startCursor, evidence.endCursor, input.operationId);
}

async function authorizeCaptured(input: Input, captured: import('@nestos/dream/vfs').CapturedEvidence, port: DreamProjectFilePort): Promise<SourceAuthority> {
    if (captured.projectId !== input.source.projectId || captured.sourceId !== input.source.id || captured.connectionId !== input.source.connectionId
        || captured.locator !== input.target) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    try {return await port.authorize(input.source);} catch {throw new Error('DREAM_SOURCE_AUTHORIZATION_FAILED');}
}

function capturedResult(input: Input, captured: import('@nestos/dream/vfs').CapturedEvidence) {
    if (captured.sourceVersion === undefined || captured.startCursor === undefined || captured.endCursor === undefined
        || captured.scanned === undefined || captured.startCursor !== input.source.cursor
        || sha256HexSync(captured.snapshot) !== captured.fingerprint) throw new Error('DREAM_CAPTURE_INVALID');
    return {status: 'ok' as const, items: [captured.snapshot], evidence: {sourceId: captured.sourceId,
        projectId: captured.projectId, connectionId: captured.connectionId, authority: captured.authority,
        startCursor: captured.startCursor, endCursor: captured.endCursor, version: captured.sourceVersion, scanned: captured.scanned}};
}

async function readScanSource(source: Input['source'], port: DreamProjectFilePort) {
    let readError: unknown;
    const [result] = await scanSources([source], 1, {...port, read: async (input, limit) => {
        try {return await port.read(input, limit);}
        catch (error) {readError = error; throw error;}
    }});
    if (result.status === 'ok') return result;
    if (readError instanceof Error && /^DREAM_(GIT|CHANGE)_[A-Z_]+$/.test(readError.message)) throw readError;
    throw new Error('DREAM_SOURCE_' + result.code);
}

async function checkOwner(authorizeOwner: () => Promise<void>): Promise<void> {
    try {await authorizeOwner();} catch {throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');}
}
async function authorize(port: SourcePort<string>, source: DreamSource) {
    try {return await port.authorize(source);} catch {throw new Error('DREAM_AUTHORIZATION_UNAVAILABLE');}
}

function verifyPlan(snapshot: Snapshot, input: Input): void {
    const plan = snapshot.plan, source = snapshot.source;
    const workspaceId = 'dream-' + sha256HexSync(JSON.stringify([input.ownerProjectId, input.dreamId]));
    if (snapshot.workspace.id !== workspaceId || snapshot.workspace.readOnly || !plan || plan.revision !== input.planRevision || !plan.data.enabled || plan.data.trigger !== 'event'
        || plan.data.mode !== 'analyze' || plan.data.rules || plan.data.sourceIds.length !== 1 || plan.data.sourceIds[0] !== input.twinSourceId
        || plan.data.kinds.length !== 1 || plan.data.kinds[0] !== 'fact'
        || !plan.data.executor || !plan.data.maxOutputTokens || !plan.data.runTokenLimit
        || !source || !source.data.enabled || source.data.kind !== (input.sourceKind ?? 'file') || source.data.target !== input.target) throw new Error('DREAM_SCAN_PLAN_CHANGED');
}

/** Read-only validation used when attaching a frozen plan to a Dream configuration. */
export async function validateDreamTwinFilePlan(input: DreamTwinFileScanInput, twin: DreamTwinScanner, port: DreamProjectFilePort): Promise<void> {
    if (port.target(input.source) !== input.target) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    verifyPlan(await twin.dreamScanEvidence(input.operationId, input.planId, input.twinSourceId), input);
}

function verifyExecution(snapshot: Snapshot, input: Input, runId: string, length: number, version: string, capturedHash?: string) {
    const run = snapshot.run, source = snapshot.source;
    const jobs = snapshot.jobs.filter(item => item.data.scanScope?.runId === runId && item.data.sourceId === input.twinSourceId)
        .map(item => item.data).sort((a, b) => (a.start ?? a.offset) - (b.start ?? b.offset));
    if (!run || run.data.state !== 'succeeded' || run.data.planId !== input.planId || run.data.planRevision !== input.planRevision
        || run.data.sourceIds.length !== 1 || run.data.sourceIds[0] !== input.twinSourceId || !jobs.length || jobs.length > 17 || !source
        || capturedHash !== undefined && jobs.some(job => job.sourceHash !== capturedHash)
        || capturedHash === undefined && (source.data.status !== 'available'
            || JSON.stringify([source.data.nativeIdentity, source.data.hash]) !== version || jobs.some(job => job.sourceHash !== source.data.hash)))
        throw new Error('DREAM_EXECUTION_UNVERIFIED');
    let offset = 0;
    const tasks = new Set<string>();
    for (const job of jobs) {
        const task = JSON.stringify([job.sessionId, job.taskId]);
        if (job.state !== 'committed' || !job.taskId || tasks.has(task) || (job.start ?? job.offset) !== offset || job.end <= offset || job.end > length)
            throw new Error('DREAM_EXECUTION_UNVERIFIED');
        tasks.add(task);
        offset = job.end;
    }
    if (offset !== length) throw new Error('DREAM_EXECUTION_UNVERIFIED');
    return jobs;
}

async function readJobOutputs(jobs: ReturnType<typeof verifyExecution>, kernel: Pick<Kernel, 'task'>, text: string) {
    const outputs = [];
    for (const job of jobs) {
        const task = await kernel.task(job.sessionId, job.taskId), result = task.exit?.output as TaskCallResult | undefined;
        if (task.id !== job.taskId || task.sessionId !== job.sessionId || task.exit?.status !== 'succeeded' || result?.exit.status !== 'succeeded')
            throw new Error('DREAM_EXECUTION_UNVERIFIED');
        const raw = scannerOutput(result.exit.output, job.executor?.outputPath), chunk = text.slice(job.start ?? job.offset, job.end);
        const candidates = parseCandidates(typeof raw === 'string' ? raw : JSON.stringify(raw), chunk);
        outputs.push({text: chunk, candidates, parsed: typeof raw === 'string' ? JSON.parse(raw) as unknown : raw});
    }
    return outputs;
}

function findingsFor(snapshot: Snapshot, input: Input, runId: string, text: string, captured: boolean): DreamFinding[] {
    return snapshot.memories.filter(item => item.data.scanRunId === runId).map(item => {
        if (!captured && !item.supported || !['candidate', 'active'].includes(item.data.state) || item.data.sourceId !== input.twinSourceId
            || item.data.kind !== 'fact' || !item.data.quote || !text.includes(item.data.quote))
            throw new Error('DREAM_RESULT_UNSUPPORTED');
        return {id: item.id, sourceId: input.source.id, kind: 'fact', content: item.data.content,
            quote: item.data.quote, subject: item.data.subject, project: item.data.project,
            eventTime: item.data.eventTime, recordedAt: item.data.recordedAt};
    });
}

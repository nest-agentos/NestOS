import {sha256HexSync, createModuleLogger} from '@nestos/common';
import {parseDerivedFindings, scanSources, sameAuthority, type DreamSource, type SourcePort, type SourceAuthority} from '@nestos/dream';
import type {DigitalTwinService} from '../digital-twin/service';
import type {DreamEvidenceStore, DreamFinding} from './evidence-store';
import type {Kernel, TaskCallResult} from '@nestos/durable-kernel';
import type {DreamProjectFilePort} from './project-file-source';
import {TWIN_CHUNK_CHARACTERS} from '../digital-twin/chunking';
import {scannerOutput} from '../digital-twin/scanner-executor';
import {parseCandidates} from '../digital-twin/extraction';

export type DreamTwinScanner = Pick<DigitalTwinService, 'dreamScanEvidence' | 'triggerScanPlan' | 'waitScanRun'>;
type Twin = DreamTwinScanner;
type Snapshot = Awaited<ReturnType<Twin['dreamScanEvidence']>>;
export interface DreamTwinFileScanInput {
    ownerProjectId: string; dreamId: string; operationId: string; planId: string; planRevision: string;
    twinSourceId: string; target: string; source: DreamSource;
    sourceKind?: 'file' | 'managed-artifact';
    configRevision?: number;
}
type Input = DreamTwinFileScanInput;
const log = createModuleLogger('dream-scan');

/** A Twin event provides the stable execution identity; its committed task is verified before Dream settlement. */
export async function runDreamTwinFileScan(input: Input, twin: Twin, port: DreamProjectFilePort, store: DreamEvidenceStore,
    kernel: Pick<Kernel, 'task'>, authorizeOwner: () => Promise<void>, registerRun?: (runId: string, authority: SourceAuthority) => Promise<void>): Promise<void> {
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
        const result = await readScanSource(input.source, port);
        if (!result.items.length) {await checkOwner(authorizeOwner); await store.settle(input.ownerProjectId, input.dreamId, input.operationId, [result], [], undefined, requestHash, input.configRevision); return;}
        if (result.items.length !== 1 || result.items[0].length > TWIN_CHUNK_CHARACTERS) throw new Error('DREAM_SOURCE_LIMIT');
        stage = 'execute';
        await checkOwner(authorizeOwner);
        if (input.configRevision !== undefined) await store.checkConfig(input.ownerProjectId, input.dreamId, input.configRevision);
        if (!sameAuthority(result.evidence.authority, await authorize(port, input.source))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const eventId = sha256HexSync(JSON.stringify([input.ownerProjectId, input.dreamId, input.operationId]));
        const runId = await twin.triggerScanPlan(input.planId, eventId, registerRun ? id => registerRun(id, result.evidence.authority) : undefined);
        if (registerRun) await registerRun(runId, result.evidence.authority);
        await twin.waitScanRun(runId);
        stage = 'verify';
        const after = await twin.dreamScanEvidence(input.operationId, input.planId, input.twinSourceId, runId); verifyPlan(after, input);
        const job = verifyExecution(after, input, runId, result.evidence.version);
        const task = await kernel.task(job.sessionId, job.taskId);
        const taskResult = task.exit?.output as TaskCallResult | undefined;
        if (task.id !== job.taskId || task.sessionId !== job.sessionId || task.exit?.status !== 'succeeded'
            || taskResult?.exit.status !== 'succeeded') throw new Error('DREAM_EXECUTION_UNVERIFIED');
        const current = await authorize(port, input.source);
        if (!sameAuthority(result.evidence.authority, current)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const fresh = await port.read({...input.source, cursor: null}, 1);
        if (fresh.version !== result.evidence.version) throw new Error('DREAM_SOURCE_CHANGED');
        const final = await authorize(port, input.source);
        if (!sameAuthority(result.evidence.authority, final)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        const raw = scannerOutput(taskResult.exit.output, job.executor?.outputPath);
        const candidates = parseCandidates(typeof raw === 'string' ? raw : JSON.stringify(raw), result.items[0]);
        const findings = findingsFor(after, input, runId, result.items[0]);
        const candidateKeys = candidates.map(candidate => JSON.stringify([candidate.content, candidate.quote, candidate.subject, candidate.project, candidate.eventTime])).sort();
        const findingKeys = findings.map(finding => JSON.stringify([finding.content, finding.quote, finding.subject, finding.project, finding.eventTime])).sort();
        if (candidates.some(candidate => candidate.kind !== 'fact' || candidate.relation !== undefined)
            || JSON.stringify(candidateKeys) !== JSON.stringify(findingKeys))
            throw new Error('DREAM_RESULT_UNSUPPORTED');
        const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
        const derived = parseDerivedFindings(parsed, result.items[0]).map((item, index) => ({...item,
            id: 'dream-' + sha256HexSync(JSON.stringify([runId, index, item])), sourceId: input.source.id, recordedAt: job.createdAt}));
        stage = 'settle';
        await checkOwner(authorizeOwner);
        await store.settle(input.ownerProjectId, input.dreamId, input.operationId, [result], [...findings, ...derived],
            {scanRunId: runId, sessionId: job.sessionId, taskId: job.taskId}, requestHash, input.configRevision);
        log.info('dream.scan', {operationId: input.operationId, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
            : stage === 'settle' ? 'DREAM_SETTLEMENT_FAILED' : stage === 'execute' ? 'DREAM_EXECUTION_FAILED' : 'DREAM_SCAN_FAILED';
        if (prepared) await store.fail(input.ownerProjectId, input.dreamId, input.operationId, code).catch(() => {
            log.warn('dream.scan.history', {operationId: input.operationId, stage: 'failure-record', result: 'failure', code: 'DREAM_HISTORY_WRITE_FAILED', durationMs: Date.now() - started});
        });
        log.warn('dream.scan', {operationId: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId) ? input.operationId : 'invalid',
            stage, result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
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

function verifyExecution(snapshot: Snapshot, input: Input, runId: string, version: string) {
    const run = snapshot.run, source = snapshot.source;
    const jobs = snapshot.jobs.filter(item => item.data.scanScope?.runId === runId && item.data.sourceId === input.twinSourceId);
    if (!run || run.data.state !== 'succeeded' || run.data.planId !== input.planId || run.data.planRevision !== input.planRevision
        || run.data.sourceIds.length !== 1 || run.data.sourceIds[0] !== input.twinSourceId || jobs.length !== 1
        || jobs[0].data.state !== 'committed' || !jobs[0].data.taskId || !source || source.data.status !== 'available'
        || JSON.stringify([source.data.nativeIdentity, source.data.hash]) !== version || jobs[0].data.sourceHash !== source.data.hash)
        throw new Error('DREAM_EXECUTION_UNVERIFIED');
    return jobs[0].data;
}

function findingsFor(snapshot: Snapshot, input: Input, runId: string, text: string): DreamFinding[] {
    return snapshot.memories.filter(item => item.data.scanRunId === runId).map(item => {
        if (!item.supported || !['candidate', 'active'].includes(item.data.state) || item.data.sourceId !== input.twinSourceId
            || item.data.kind !== 'fact' || !item.data.quote || !text.includes(item.data.quote))
            throw new Error('DREAM_RESULT_UNSUPPORTED');
        return {id: item.id, sourceId: input.source.id, kind: 'fact', content: item.data.content,
            quote: item.data.quote, subject: item.data.subject, project: item.data.project,
            eventTime: item.data.eventTime, recordedAt: item.data.recordedAt};
    });
}

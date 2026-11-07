import {randomUUID} from '@nestos/common';
import type {TwinViewRequest, TwinViewSnapshot, TwinScanRun, TwinScanPlan, TwinPageInfo} from '@nestos/app-contracts/services';
import type {TwinMemoryData, TwinSourceData, TwinSettings, TwinAnalysisJob} from './domain';
import {TwinRecords, type TwinDataRecord} from './records';
import {TwinScans} from './scans';
import {supported} from './knowledge';
import {knowledgeGraph, type TwinEntityAlias} from './graph';
import {meterSnapshot} from './metering';
import {extractionPrompt} from './extraction';
const LIMIT = 20;
type Family = 'source' | 'scan-run' | 'job';

/** Keep execution records authoritative; page queries never truncate or rewrite stored runs. */
export async function readTwinView(records: TwinRecords, scans: TwinScans, workspace: TwinViewSnapshot['workspace'], request: TwinViewRequest): Promise<TwinViewSnapshot> {
    const started = Date.now(), operationId = randomUUID();
    let stage = 'validate';
    try {
        validateRequest(request); stage = request.page;
        const [knowledge, settings, plans, status] = await Promise.all([readKnowledge(records, request),
            records.get<TwinSettings>('settings', 'pot'), ['sources', 'runs'].includes(request.page) ? records.list<TwinScanPlan>('scan-plan') : Promise.resolve([]), scans.viewStatus()]);
        const [sourcePage, runPage, metering] = await Promise.all([readSources(records, request), readRuns(records, request, plans), meterSnapshot(records, request.page === 'sources' ? 100 : 0)]);
        const cleanupError = await records.store.cleanupError();
        const pendingCleanup = (await records.store.pendingCleanup()).map(row => ({...row, records: [], cursors: {}}));
        const runJobs = request.runId ? await matching<TwinAnalysisJob>(records, 'job', row => row.data.scanScope?.runId === request.runId, 0, 10000) : [];
        const jobPage = {offset: request.offset ?? 0, limit: LIMIT, total: runJobs.length};
        const jobs = runJobs.slice(jobPage.offset, jobPage.offset + LIMIT);
        const schedules = request.page === 'sources' ? await Promise.all(plans.map(async plan => ({planId: plan.id, nextAt: (await scans.plans.schedule(plan.id))?.data.nextAt ?? 0}))) : [];
        const {referencedSources, ...knowledgeView} = knowledge;
        const result = {...knowledgeView, settings: settings!, workspace, metering, prompt: request.page === 'sources' ? extractionPrompt(settings!.data) : '',
            cleanupError, pendingCleanup, sources: (request.page === 'profile' ? referencedSources : sourcePage.rows).map(row => ({...row, observedAt: row.data.checkedAt})),
            jobs, uses: [], sessions: [], scans: {...status, plans, runs: runPage.rows, schedules}, pagination: {sources: sourcePage.page, runs: runPage.page, ...(request.runId ? {jobs: jobPage} : {})}};
        console.info('[DigitalTwinView]', {operation: 'twin.readView', operationId, stage: request.page, result: 'success', sources: result.sources.length, runs: result.scans.runs.length, durationMs: Date.now() - started});
        return result;
    } catch (error) {
        console.warn('[DigitalTwinView]', {operation: 'twin.readView', operationId, stage, result: 'failure', code: error instanceof Error && /^TWIN_[A-Z_]+$/.test(error.message) ? error.message : 'TWIN_VIEW_READ_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}
function validateRequest(request: TwinViewRequest): void {
    if (!request || !['overview', 'profile', 'memories', 'goals', 'sources', 'runs'].includes(request.page)
        || request.offset !== undefined && (!Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > 10000)
        || ['query', 'runId', 'planId', 'tab', 'enabled', 'kind', 'state'].some(key => {const value = request[key as 'query']; return value !== undefined && (typeof value !== 'string' || value.length > 256);})) throw new Error('TWIN_INVALID_VIEW_REQUEST');
}
async function readKnowledge(records: TwinRecords, request: TwinViewRequest) {
    const rows = request.page === 'runs' ? [] : await records.list<TwinMemoryData>('memory');
    const ids = [...new Set(rows.filter(row => !row.data.independent).map(row => row.data.sourceId))];
    const sources = new Map(await Promise.all(ids.map(async id => [id, await records.get<TwinSourceData>('source', id)] as const)));
    const memories = rows.map(row => ({...row, retained: Boolean(sources.get(row.data.sourceId)?.data.retained), supported: supported(row.data, sources.get(row.data.sourceId) ?? null)}));
    const aliases = request.page === 'profile' ? new Map((await records.list<TwinEntityAlias>('entity')).map(row => [row.id, row.data])) : undefined;
    return {memories, referencedSources: [...sources.values()].filter((row): row is TwinDataRecord<TwinSourceData> => !!row), graph: request.page === 'profile' ? knowledgeGraph(memories, aliases) : {nodes: [], edges: []}};
}
async function readSources(records: TwinRecords, request: TwinViewRequest) {
    const total = await records.store.count('source'), offset = request.offset ?? 0;
    if (request.page !== 'sources' || request.tab !== 'sources') return {rows: [], page: {offset: 0, limit: LIMIT, total}};
    const query = request.query?.trim().toLocaleLowerCase();
    if (!query && !request.enabled && !request.kind && !request.state) return {rows: await records.page<TwinSourceData>('source', offset, LIMIT), page: {offset, limit: LIMIT, total}};
    const matches = await matching<TwinSourceData>(records, 'source', row => {
        const data = row.data, text = [data.label, data.target, data.resource?.projectName, data.resource?.projectId].join(' ').toLocaleLowerCase();
        return (!query || text.includes(query)) && (!request.enabled || String(data.enabled) === request.enabled)
            && (!request.kind || data.kind === request.kind) && (!request.state || data.status === request.state);
    }, 0, 10000);
    return {rows: matches.slice(offset, offset + LIMIT), page: {offset, limit: LIMIT, total: matches.length, all: total}};
}
async function readRuns(records: TwinRecords, request: TwinViewRequest, plans: TwinDataRecord<TwinScanPlan>[]) {
    const total = await records.store.count('scan-run'), offset = request.offset ?? 0;
    const page: TwinPageInfo = {offset, limit: LIMIT, total};
    if (request.runId) {
        const row = await records.get<TwinScanRun>('scan-run', request.runId);
        if (!row) throw new Error('TWIN_SCAN_RUN_UNAVAILABLE');
        return {rows: [row], page};
    }
    if (request.page === 'runs' || request.page === 'sources' && request.tab === 'runs') {
        const rows = request.planId ? await matching<TwinScanRun>(records, 'scan-run', row => row.data.planId === request.planId, offset, LIMIT)
            : await records.page<TwinScanRun>('scan-run', offset, LIMIT, true);
        return {rows: rows.map(summarizeRun), page};
    }
    const rows = request.page === 'sources' && (!request.tab || request.tab === 'plans') ? await recentPlanRuns(records, plans.map(plan => plan.id)) : [];
    return {rows, page};
}
export async function recentPlanRuns(records: TwinRecords, planIds: string[]): Promise<TwinDataRecord<TwinScanRun>[]> {
    return (await records.store.recentRuns(planIds)).map(row => ({id: row.id, revision: row.revision, data: row.payload as unknown as TwinScanRun}));
}
function summarizeRun(row: TwinDataRecord<TwinScanRun>): TwinDataRecord<TwinScanRun> {
    const data = row.data;
    return {...row, data: {...data, sourceCount: data.sourceIds.length, completedSourceCount: data.completedSourceIds.length,
        sourceIds: [], completedSourceIds: [], ...(data.collection ? {collection: {...data.collection, values: undefined}} : {})}};
}
async function matching<T>(records: TwinRecords, family: Family, match: (row: TwinDataRecord<T>) => boolean, offset: number, limit: number) {
    const selected: TwinDataRecord<T>[] = []; let skipped = 0;
    for (let start = 0; start < 10000 && selected.length < limit; start += 100) {
        const rows = await records.page<T>(family, start, 100, family !== 'source');
        for (const row of rows) if (match(row) && skipped++ >= offset && selected.length < limit) selected.push(row);
        if (rows.length < 100) break;
    }
    return selected;
}

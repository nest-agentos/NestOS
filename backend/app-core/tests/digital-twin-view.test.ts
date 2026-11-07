import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DigitalTwinService, TWIN_KINDS} from '../src';
import {SeqTwinStore} from '../src/digital-twin/seq-twin-store';
import type {TwinScanRun} from '@nestos/app-contracts/services';
import type {TwinRecordWrite} from '../src/digital-twin/contracts';
const releases: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks();});

export async function viewFixture(sourceCount = 225, runCount = 260) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); releases.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    const service = new DigitalTwinService({fs, reader: {sessions: async () => [], read: async spec => ({text: 'Evidence', hash: 'hash', nativeIdentity: spec.target})},
        extractor: {run: async (_job, _text, attached) => {await attached('fixture-task'); return {candidates: [], tokens: 0};}, cleanup: vi.fn(), cancel: vi.fn()}, deleteSession: vi.fn()}); releases.push(() => service.dispose());
    const sourceId = await service.addSource({kind: 'file', target: 'source-0.md', label: 'Source 0'}, 'model');
    const source = (await service.snapshot()).sources.find(row => row.id === sourceId)!;
    const planId = await service.saveScanPlan(null, null, {name: 'Scanner', sourceIds: [sourceId], connectionId: 'model', kinds: [...TWIN_KINDS],
        mode: 'analyze', trigger: 'manual', intervalMinutes: 30, enabled: false, tokenLimit: 100000});
    const plan = (await service.snapshot()).scans.plans.find(row => row.id === planId)!;
    const store = await SeqTwinStore.open(fs, 'personal', 'admin');
    const run: TwinScanRun = {...plan.data, planId, planRevision: plan.revision, completedSourceIds: [], state: 'succeeded', singleBatch: false,
        sourceIds: Array.from({length: Math.min(sourceCount, 142)}, (_, i) => 'source-' + i), reservedTokens: 0, spentTokens: 10,
        startedAt: 1, finishedAt: 2, owner: '', fence: 1, error: ''};
    const writes: TwinRecordWrite[] = Array.from({length: sourceCount - 1}, (_, index) => ({family: 'source', id: 'source-' + (index + 1), expectedRevision: null,
        payload: {...source.data, target: `source-${index + 1}.md`, label: `Source ${index + 1}`}}));
    writes.push(...Array.from({length: runCount}, (_, index) => ({family: 'scan-run' as const, id: 'run-' + String(index).padStart(5, '0'), expectedRevision: null,
        payload: {...run, createdAt: index + 1, finishedAt: index + 2}})));
    for (let index = 0; index < writes.length; index += 100) await store.commit({operationId: 'seed-' + index, expectedForgetEpoch: 0, writes: writes.slice(index, index + 100)});
    return {service, store, fs, planId, manager, sourceId};
}
it('reads bounded overview, pages every source/run, and keeps full details behind a stable run ID', async () => {
    const f = await viewFixture(), legacy = vi.spyOn(f.service, 'snapshot');
    const view = await f.service.readView({page: 'overview'});
    expect(view.sources).toHaveLength(0); expect(view.jobs).toHaveLength(0); expect(view.scans.runs).toHaveLength(0);
    expect(view.pagination).toMatchObject({sources: {total: 225}, runs: {total: 260}});
    const first = await f.service.readView({page: 'runs'}), next = await f.service.readView({page: 'runs', offset: 20});
    expect(first.scans.runs).toHaveLength(20); expect(first.scans.runs[0].id).toBe('run-00259');
    expect(next.scans.runs[0].id).toBe('run-00239'); expect(first.scans.runs[0].data.sourceCount).toBe(142);
    expect(first.scans.runs[0].data.sourceIds).toEqual([]);
    expect((await f.service.readView({page: 'runs', runId: 'run-00000'})).scans.runs[0].data.sourceIds).toHaveLength(142);
    expect((await f.service.readView({page: 'sources', tab: 'sources', query: 'Source 224'})).sources.map(row => row.id)).toEqual(['source-224']);
    expect((await f.service.readView({page: 'sources', tab: 'sources', offset: 220})).sources).toHaveLength(5);
    expect(legacy).not.toHaveBeenCalled();
});
it('rebuilds legacy recent-run indexes once and updates/forgets them in the source transaction', async () => {
    const f = await viewFixture(1, 260), path = '/var/lib/digital-twin/personal/indexes.seq';
    await f.fs.meta.seq!.deleteEntry(path, 'recent-runs/ready-v1');
    const initial = await f.service.activitySummary(); expect(initial.runs[0].id).toBe('run-00259');
    const spy = vi.spyOn(f.store, 'list');
    expect((await f.store.recentRuns([f.planId]))).toHaveLength(5); expect(spy).not.toHaveBeenCalled();
    const row = (await f.store.read({family: 'scan-run', id: 'run-00259'}))!;
    await f.store.commit({operationId: 'failed', expectedForgetEpoch: 0, writes: [{...row, expectedRevision: row.revision, payload: {...row.payload, state: 'failed', error: 'TEST_FAILURE'}}]});
    expect((await f.service.activitySummary()).runs[0].state).toBe('failed');
    await f.store.startForget({operationId: 'forget-run', expectedForgetEpoch: 0, records: [{family: 'scan-run', id: row.id}]});
    expect((await f.service.activitySummary()).runs[0].id).toBe('run-00258');
    await expect(f.service.readView({page: 'runs', runId: row.id})).rejects.toThrow('TWIN_SCAN_RUN_UNAVAILABLE');
});
it('keeps payloads bounded at the live dataset scale without fetching unrelated history', async () => {
    const f = await viewFixture(1665, 2937), read = vi.spyOn(SeqTwinStore.prototype, 'list');
    const started = performance.now(), result = await f.service.readView({page: 'overview'});
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    const runs = await f.service.readView({page: 'runs'});
    expect(Buffer.byteLength(JSON.stringify(runs))).toBeLessThan(256 * 1024);
    expect(runs.scans.runs).toHaveLength(20); expect(result.pagination?.runs.total).toBe(2937);
    expect(read.mock.calls.filter(([family]) => family === 'scan-run')).toEqual([['scan-run', {offset: 0, limit: 20, reverse: true}]]);
    expect(read.mock.calls.some(([family]) => family === 'source' || family === 'job')).toBe(false);
    expect(performance.now() - started).toBeLessThan(5000);
});
it('pages task references and retains cleanup errors from jobs outside the visible page', async () => {
    const f = await viewFixture(1, 1);
    await f.service.analyze(f.sourceId);
    const base = (await f.store.list('job'))[0];
    expect(base).toBeDefined();
    const writes: TwinRecordWrite[] = Array.from({length: 45}, (_, index) => ({family: 'job', id: 'page-job-' + index, expectedRevision: null,
        payload: {...base.payload, scanScope: {...base.payload.scanScope as object, runId: 'run-00000'}, cleaned: index !== 0, cleanupError: index === 0 ? 'TWIN_CLEANUP_FAILED' : ''}}));
    await f.store.commit({operationId: 'job-pages', expectedForgetEpoch: 0, writes});
    const first = await f.service.readView({page: 'runs', runId: 'run-00000'});
    expect(first.jobs).toHaveLength(20); expect(first.pagination?.jobs?.total).toBe(45);
    expect(first.cleanupError).toBe('TWIN_CLEANUP_FAILED');
    const last = await f.service.readView({page: 'runs', runId: 'run-00000', offset: 40});
    expect(last.jobs).toHaveLength(5); expect(last.jobs.some(row => row.id === 'page-job-0')).toBe(true);
    expect((await f.service.readView({page: 'overview'})).cleanupError).toBe('TWIN_CLEANUP_FAILED');
    await f.store.startForget({operationId: 'forget-job', expectedForgetEpoch: 0, records: [{family: 'job', id: 'page-job-0'}]});
    expect((await f.service.readView({page: 'overview'})).cleanupError).toBe('');
});
it.each([-1, 1.5, 10001])('rejects invalid paging instead of enumerating all history: %s', async offset => {
    const f = await viewFixture(1, 0);
    await expect(f.service.readView({page: 'runs', offset})).rejects.toThrow('TWIN_INVALID_VIEW_REQUEST');
});

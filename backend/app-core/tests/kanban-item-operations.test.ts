import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/common';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createItemOperations} from '../src/kanban/item-operations';
import {jobKey, reviewKey, type ReviewOperationsOptions, type ReviewJob} from '../src/kanban/item-operation-types';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const journal = new KanbanAutomationJournal(await manager.openFileSystem('/'), kanbanJournalOptions); await journal.open();
    const item = {id: 'task', title: 'Task', revision: 1, status: 'review'}, snapshot = {version: 'scope', sourceVersion: 'source', targetVersion: 'target', context: {worktreeId: 'original'}};
    const board = {id: 'board', members: [{kind: 'human', id: 'admin', roles: ['coordinator']}]};
    const target = {kind: 'flow', id: 'project-operation', version: '1', digest: 'digest'}, reference = {system: 'nestos-published-flow', id: target.id, revision: JSON.stringify([target.version, target.digest])};
    const actor = {kind: 'human', id: 'admin'};
    const published = {start: vi.fn(async () => ({state: 'running'})), inspect: vi.fn(async () => ({state: 'running'}))};
    const submission = {start: vi.fn(async () => ({sessionId: 'original', outcome: 'running'})), inspect: vi.fn(async () => ({sessionId: 'original', outcome: 'succeeded'}))};
    const request = {expectedSessionId: 'original', expectedBranch: 'main', submission: {id: 'analysis', source: {kind: 'conversation', ownerId: 'original', id: 'analysis'}}};
    const plan = {sourceVersion: 'source', targetVersion: 'target', summary: 'One conflict', conflicts: [{id: 'file', path: 'file.ts', reason: 'Both edited', options: [{id: 'retain', label: 'Keep target'}, {id: 'integrate', label: 'Integrate changes'}]}]};
    const adapter = {supports: () => true, snapshot: vi.fn(async () => ({...snapshot})), runningVersion: vi.fn(() => 'candidate'),
        prepareAnalysis: vi.fn(async () => request), readAnalysis: vi.fn(async () => plan)};
    const service = {read: async () => board, item: async () => ({item}), currentPrincipal: async () => actor, workflow: async () => ({dispatches: {execution: {id: 'execution', itemId: 'task', attempt: 1, outcome: 'succeeded'}}}), execute: vi.fn(async () => {item.status = 'completed'; item.revision++;})};
    const options = {journal, service, adapter, published, submission, log: vi.fn(), catalog: async () => ({entries: [{name: 'Project operation', target, input: {parameters: [{name: 'context', type: 'string'}]}}]})} as unknown as ReviewOperationsOptions;
    const api = createItemOperations(options); closes.push(() => api.quiesce());
    const run = async (action: string, id = action, extra = {}) => api.runItemOperation('board', {operationId: id, itemId: 'task', action, expectedRevision: (await api.itemOperations('board', 'task')).revision, ...extra});
    const bind = async (action: string) => api.bindItemOperation('board', {operationId: 'bind-' + action, itemId: 'task', action, expectedRevision: (await api.itemOperations('board', 'task')).revision, target: reference});
    const result = (id: string, version = 'candidate') => ({schema: 'nestos.kanban.operation-result/1', operationId: id, sourceVersion: 'source', targetVersion: 'target', version});
    const complete = (id: string) => published.inspect.mockResolvedValue({state: 'succeeded', output: result(id)} as never);
    return {api, options, journal, item, actor, published, submission, adapter, snapshot, plan, reference, run, bind, complete, result, service};
}
it('does not start anything on query and requires a compatible frozen Flow binding', async () => {
    const f = await fixture(), view = await f.api.itemOperations('board', 'task');
    expect(view.operations.find(op => op.id === 'build')).toMatchObject({enabled: false, configurable: true});
    expect(view.targets).toHaveLength(1); expect(f.published.start).not.toHaveBeenCalled(); expect(f.submission.start).not.toHaveBeenCalled();
    await f.bind('build'); await f.run('build'); expect(f.published.start).toHaveBeenCalledOnce();
    const input = f.published.start.mock.calls[0][0] as never as {request: {expectedSessionId: string; source: {values: {context: string}}}};
    expect(input.request.expectedSessionId).toBe('build'); expect(JSON.parse(input.request.source.values.context)).toMatchObject({operationId: 'build', action: 'build', sourceVersion: 'source', resources: {worktreeId: 'original'}});
});
it('keeps a lost admission reply unknown and only reconciles after restart', async () => {
    const f = await fixture(); await f.bind('build');
    f.published.start.mockRejectedValueOnce(Object.assign(new Error('Lost'), {code: 'TRANSPORT_DISCONNECTED'}));
    const request = {operationId: 'build', itemId: 'task', action: 'build', expectedRevision: (await f.api.itemOperations('board', 'task')).revision};
    await f.api.runItemOperation('board', request); f.published.inspect.mockResolvedValue({state: 'unknown'});
    await f.api.quiesce(); const restored = createItemOperations(f.options); closes.push(() => restored.quiesce());
    await restored.scan(); await restored.runItemOperation('board', request);
    expect(f.published.start).toHaveBeenCalledOnce(); expect(f.published.inspect).toHaveBeenCalled();
    expect((await f.journal.get<ReviewJob>(jobKey('build')))!.phase).toBe('submitting');
});
it('retries only a proven pre-admission ownership rejection with the same identity', async () => {
    const f = await fixture(); await f.bind('build');
    f.published.start.mockRejectedValueOnce(Object.assign(new Error('Owned'), {code: 'OPERATION_SESSION_OWNED', executionOutcome: 'not-started', retryable: true}));
    await f.run('build'); expect((await f.journal.get<ReviewJob>(jobKey('build')))!.phase).toBe('prepared');
    await f.api.scan(); expect(f.published.start).toHaveBeenCalledTimes(2);
    expect(f.published.start.mock.calls[0][0]).toEqual(f.published.start.mock.calls[1][0]);
});
it('rejects stale UI requests and source changes before replacement', async () => {
    const f = await fixture(), stale = (await f.api.itemOperations('board', 'task')).revision;
    await f.bind('build'); await expect(f.api.runItemOperation('board', {operationId: 'old', itemId: 'task', action: 'build', expectedRevision: stale})).rejects.toMatchObject({code: 'OPERATION_STALE_REFRESH'});
    await f.bind('deploy'); await f.run('build'); f.complete('build'); await f.api.itemOperations('board', 'task');
    f.snapshot.version = 'changed'; await expect(f.run('deploy', 'deploy', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_SOURCE_CHANGED_REBUILD'});
    expect(f.published.start).toHaveBeenCalledOnce();
});
it('continues the original Session, requires every conflict choice, and invalidates stale analysis', async () => {
    const f = await fixture(); await f.run('analyze');
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original'})); expect(f.published.start).not.toHaveBeenCalled();
    await f.api.itemOperations('board', 'task'); f.item.status = 'completed'; await f.bind('merge');
    await expect(f.run('merge', 'no-choice', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_SELECTION_REQUIRED'});
    f.snapshot.version = 'changed'; await expect(f.run('merge', 'stale-plan', {confirmed: true, selections: {file: 'integrate'}})).rejects.toMatchObject({code: 'OPERATION_SOURCE_CHANGED_REANALYZE'});
    f.snapshot.version = 'scope'; await f.run('merge', 'merge', {confirmed: true, selections: {file: 'integrate'}});
    const input = f.published.start.mock.calls[0][0] as never as {request: {source: {values: {context: string}}}};
    expect(JSON.parse(input.request.source.values.context).input).toMatchObject({approvalId: 'merge', analysisId: 'analyze', analysisDigest: sha256HexSync(JSON.stringify(f.plan)), selections: {file: 'integrate'}});
    f.complete('merge'); const view = await f.api.itemOperations('board', 'task'); expect(view.operations.find(op => op.id === 'merge')).toMatchObject({state: 'succeeded', enabled: false});
});
it('checks the real running version before acceptance and journals canonical acceptance once', async () => {
    const f = await fixture(); await f.bind('build'); await f.bind('deploy'); await f.run('build'); f.complete('build'); await f.api.itemOperations('board', 'task');
    f.published.inspect.mockResolvedValue({state: 'running'}); await f.run('deploy', 'deploy', {confirmed: true}); f.complete('deploy'); await f.api.itemOperations('board', 'task');
    f.adapter.runningVersion.mockReturnValue('other'); await expect(f.run('accept', 'not-this-version', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_RUNNING_VERSION_MISMATCH'});
    f.adapter.runningVersion.mockReturnValue('candidate'); const view = await f.run('accept', 'accept', {confirmed: true});
    expect(f.service.execute).toHaveBeenCalledOnce(); expect(f.service.execute.mock.calls[0][1]).toMatchObject({command: {type: 'accept-execution', dispatchId: 'execution', accept: true}});
    await f.api.scan(); expect(f.service.execute).toHaveBeenCalledOnce(); expect(view.operations.find(op => op.id === 'accept')?.state).toBe('succeeded');
});
it('refuses malformed output and does not enable dependent actions', async () => {
    const f = await fixture(); await f.bind('build'); await f.bind('deploy'); await f.run('build');
    f.published.inspect.mockResolvedValue({state: 'succeeded', output: {...f.result('build'), sourceVersion: 'somebody-else'}} as never);
    const view = await f.api.itemOperations('board', 'task'); expect(view.operations.find(op => op.id === 'build')).toMatchObject({state: 'failed', code: 'OPERATION_RESULT_SCOPE_MISMATCH'});
    expect(view.operations.find(op => op.id === 'deploy')?.enabled).toBe(false);
});
it('requires a human coordinator and validates requests before journal access', async () => {
    const f = await fixture(); f.actor.kind = 'service'; await expect(f.bind('build')).rejects.toMatchObject({code: 'OPERATION_COORDINATOR_REQUIRED'});
    expect(() => f.api.runItemOperation('board', null as never)).toThrow();
    expect(() => f.api.bindItemOperation('board', {operationId: '__proto__'} as never)).toThrow();
    expect(await f.journal.get(reviewKey('board', 'task'))).toBeUndefined();
});
it('blocks cleanup while an operation is prepared, running or unknown', async () => {
    const f = await fixture(); await f.bind('build'); await f.run('build'); const cleanup = vi.fn(async () => 'cleaned');
    await expect(f.api.guardResource('board', 'task', cleanup)).rejects.toMatchObject({code: 'WORKTREE_IN_USE'}); expect(cleanup).not.toHaveBeenCalled();
    f.complete('build'); await f.api.itemOperations('board', 'task'); expect(await f.api.guardResource('board', 'task', cleanup)).toBe('cleaned');
});
it('reconciles canonical accepted state after an acceptance reply was lost without replaying it', async () => {
    const f = await fixture();
    const job: ReviewJob = {id: 'accepted', action: 'accept', boardId: 'board', itemId: 'task', fingerprint: 'fingerprint', snapshot: {...f.snapshot}, phase: 'prepared', state: 'unknown', createdAt: 0, acceptanceVersion: 'old-service', command: {type: 'accept-execution', dispatchId: 'execution', accept: true}};
    await f.journal.update(jobKey(job.id), () => job); await f.journal.update(reviewKey('board', 'task'), () => ({revision: 1, bindings: {}, receipts: {}, jobs: [job.id]}));
    await f.journal.update('review-operation-scopes', () => [{board: 'board', item: 'task'}]);
    f.item.status = 'completed'; f.snapshot.version = 'now-changed'; f.service.workflow = async () => ({dispatches: {execution: {id: 'execution', itemId: 'task', attempt: 1, outcome: 'accepted'}}});
    await f.api.scan(); expect((await f.journal.get<ReviewJob>(jobKey(job.id)))!.state).toBe('succeeded'); expect(f.service.execute).not.toHaveBeenCalled();
});
it('uses the original Session for project maintenance without a Flow selection or catalog lookup', async () => {
    const f = await fixture();
    f.options.adapter.prepareOperation = vi.fn(async () => ({expectedSessionId: 'original', expectedBranch: 'main', submission: {id: 'build', source: {kind: 'conversation', ownerId: 'original', id: 'build'}}}) as never);
    f.options.adapter.readOperation = vi.fn(async () => ({...f.result('build'), status: 'succeeded'}));
    f.options.catalog = vi.fn(async () => {throw new Error('A Flow is not required');});
    const view = await f.api.itemOperations('board', 'task'); expect(view.operations.find(op => op.id === 'build')).toMatchObject({enabled: true, configurable: false});
    await f.run('build'); expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original'}));
    expect(f.published.start).not.toHaveBeenCalled(); expect(f.options.catalog).not.toHaveBeenCalled();
});
it('retains the agent prerequisite explanation when an operation reports blocked', async () => {
    const f = await fixture();
    f.options.adapter.prepareOperation = vi.fn(async () => ({expectedSessionId: 'original'}) as never);
    f.options.adapter.readOperation = vi.fn(async () => ({...f.result('build'), status: 'blocked', summary: 'The project requires a missing SDK.'}));
    const view = await f.run('build'); expect(view.operations.find(op => op.id === 'build')).toMatchObject({state: 'failed', code: 'OPERATION_RESULT_AGENT_BLOCKED', summary: expect.stringContaining('missing SDK')});
    expect(f.published.start).not.toHaveBeenCalled();
});
it('persists build-time replacement consent and starts the replacement once across restart',async()=>{
    const f=await fixture();await f.bind('build');await f.bind('deploy');await f.run('build','build-auto',{followUp:'deploy'});
    expect(f.published.start).toHaveBeenCalledOnce();f.complete('build-auto');
    const queued=await f.api.itemOperations('board','task');expect(queued.operations.find(op=>op.id==='deploy')).toMatchObject({state:'running',hideRun:true});expect(f.published.start).toHaveBeenCalledOnce();
    await f.api.quiesce();const restored=createItemOperations(f.options);closes.push(()=>restored.quiesce());await restored.scan();
    expect(f.published.start).toHaveBeenCalledTimes(2);
    const settings=await f.journal.get<any>(reviewKey('board','task')),id=settings.jobs.at(-1);
    expect((await f.journal.get<ReviewJob>(jobKey('build-auto')))?.followUp).toMatchObject({state:'started',request:{operationId:id,confirmed:true}});
    await restored.scan();expect(f.published.start).toHaveBeenCalledTimes(2);
    const view=await restored.itemOperations('board','task');expect(view.operations.find(op=>op.id==='build')?.runLabel).toBeTruthy();
});
it('retains the successful build and reveals manual replacement when automatic preparation fails',async()=>{
    const f=await fixture();await f.bind('build');await f.bind('deploy');await f.run('build','build-auto-fail',{followUp:'deploy'});f.complete('build-auto-fail');
    f.snapshot.version='changed';await f.api.scan();const view=await f.api.itemOperations('board','task');
    expect(view.operations.find(op=>op.id==='build')).toMatchObject({state:'succeeded'});
    expect(view.operations.find(op=>op.id==='deploy')).toMatchObject({hideRun:false,code:'OPERATION_SOURCE_CHANGED_REBUILD'});
    expect(f.published.start).toHaveBeenCalledOnce();
});
it('recovers replacement success from verified evidence when the old host lost the submission outcome',async()=>{
    const f=await fixture();f.options.adapter.prepareOperation=vi.fn(async()=>({expectedSessionId:'original'}) as never);
    f.options.adapter.readOperation=vi.fn(async(job)=>({...f.result(job.id),status:'succeeded'}));
    await f.run('build','build-receipt');
    f.submission.inspect.mockResolvedValue({sessionId:'original',outcome:'unknown'});
    const view=await f.run('deploy','replace-receipt',{confirmed:true});
    expect(view.operations.find(op=>op.id==='deploy')).toMatchObject({state:'succeeded'});
    expect(f.submission.start).toHaveBeenCalledTimes(2);
    await f.api.scan();expect(f.submission.start).toHaveBeenCalledTimes(2);
});

it('uses the trusted service controller once and validates its deployment result without a model request',async()=>{
 const f=await fixture();await f.bind('build');await f.bind('deploy');await f.run('build');f.complete('build');await f.api.itemOperations('board','task');
 const managed={operationId:'managed-deploy',serviceId:'host',expectedVersion:'old',targetVersion:'candidate'};
 const submit=vi.fn(async()=>{});f.options.adapter.managed={prepare:async()=>managed,submit,inspect:async()=>({state:'succeeded',output:{...f.result('managed-deploy'),status:'succeeded'}})};
 await f.run('deploy','managed-deploy',{confirmed:true});await f.api.scan();
 expect(submit).toHaveBeenCalledOnce();expect(f.published.start).toHaveBeenCalledOnce();expect(f.submission.start).not.toHaveBeenCalled();
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='deploy')).toMatchObject({state:'succeeded'});
});

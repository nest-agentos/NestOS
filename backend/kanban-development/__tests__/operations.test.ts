import {finishReviewCleanup} from '@nestos/kanban/integration';
const kanbanJournalOptions={directory:'/var/lib/kanban',artifactScheme:'nestos-kanban-artifact:'};
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/common';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createItemOperations} from '@nestos/kanban-development';
import { type ReviewOperationsOptions, type ReviewJob} from '@nestos/kanban-development';
import {jobKey, reviewKey} from '@nestos/kanban/integration';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
async function fixture(configure?:(options:ReviewOperationsOptions)=>void) {
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
    configure?.(options);
    const api = createItemOperations(options); closes.push(() => api.quiesce());
    const run = async (action: string, id = action, extra = {}) => api.runItemOperation('board', {operationId: id, itemId: 'task', action, expectedRevision: (await api.itemOperations('board', 'task')).revision, ...extra});
    const bind = async (action: string) => api.bindItemOperation('board', {operationId: 'bind-' + action, itemId: 'task', action, expectedRevision: (await api.itemOperations('board', 'task')).revision, target: reference});
    const result = (id: string, version = 'candidate') => ({schema: 'nestos.kanban.operation-result/1', operationId: id, sourceVersion: 'source', targetVersion: 'target', version});
    const complete = (id: string) => published.inspect.mockResolvedValue({state: 'succeeded', output: result(id)} as never);
    const acceptRuntime = async () => {
        await bind('build'); await bind('deploy'); await run('build'); complete('build'); await api.scan();
        published.inspect.mockResolvedValue({state:'running'}); await run('deploy','deploy',{confirmed:true}); complete('deploy'); await api.scan();
        await run('accept','accept',{confirmed:true}); published.start.mockClear(); published.inspect.mockResolvedValue({state:'running'});
    };
    return {acceptRuntime, api, options, journal, item, actor, published, submission, adapter, snapshot, plan, reference, run, bind, complete, result, service};
}
it('does not start anything on query and requires a compatible frozen Flow binding', async () => {
    const f = await fixture(), view = await f.api.itemOperations('board', 'task');
    expect(view.operations.find(op => op.id === 'build')).toMatchObject({enabled: false, configurable: true});
    expect(view.targets).toHaveLength(1); expect(f.published.start).not.toHaveBeenCalled(); expect(f.submission.start).not.toHaveBeenCalled();
    await f.bind('build'); await f.run('build'); expect(f.published.start).toHaveBeenCalledOnce();
    const input = f.published.start.mock.calls[0][0] as never as {request: {expectedSessionId: string; source: {values: {context: string}}}};
    expect(input.request.expectedSessionId).toBe('build'); expect(JSON.parse(input.request.source.values.context)).toMatchObject({operationId: 'build', action: 'build', sourceVersion: 'source', resources: {worktreeId: 'original'}});
});
it('owns repository scopes on one management task and preserves separate durable analysis receipts',async()=>{
    const f=await fixture();
    const scopes=['repo-a','repo-b'].map(id=>({id,label:id,contributors:[{itemId:id+'-source',title:'Source '+id}]}));
    f.options.scopes={describe:async(_board,item)=>item==='child'?{owner:{boardId:'board',itemId:'task'}}:{scopes},
        resolve:async(_board,_item,id)=>{
            if(!scopes.some(scope=>scope.id===id))throw Object.assign(Error('invalid'),{code:'OPERATION_SCOPE_INVALID'});
            return {deliveryPlan:async()=>({steps:['analyze','merge'],acceptance:'source'}),adapter:{...f.adapter,
                snapshot:async()=>({...f.snapshot,sourceVersion:id}),readAnalysis:async()=>({...f.plan,sourceVersion:id})}};
        }};
    const initial=await f.api.itemOperations('board','task');expect(initial.scopes).toHaveLength(2);expect(f.submission.start).not.toHaveBeenCalled();
    await expect(f.api.runItemOperation('board',{itemId:'child',action:'analyze',operationId:'bypass',expectedRevision:initial.revision})).rejects.toMatchObject({code:'OPERATION_SCOPE_REQUIRED'});
    await f.api.runItemOperation('board',{itemId:'task',scopeId:'repo-a',action:'analyze',operationId:'repo-a-analysis',expectedRevision:initial.scopes![0].view.revision});
    await f.api.scan();const next=await f.api.itemOperations('board','task');
    expect(next.scopes![0].view.operations.find(row=>row.id==='analyze')).toMatchObject({state:'succeeded'});
    expect(next.scopes![0].view.operations.find(row=>row.id==='merge')).toMatchObject({sessionId:'original'});
    expect(next.scopes![1].view.operations.find(row=>row.id==='analyze')).toMatchObject({state:'ready'});
    expect((await f.journal.get<ReviewJob>(jobKey('repo-a-analysis')))?.scopeId).toBe('repo-a');
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
it('reads committed operation state while reconciliation is blocked without starting or observing work', async () => {
    const f = await fixture(); await f.bind('build'); await f.run('build');
    let release!: () => void;
    const held = new Promise<void>(resolve => {release = resolve;});
    f.published.inspect.mockImplementation(async () => {await held; return {state: 'running'};});
    const before = f.published.inspect.mock.calls.length, scan = f.api.scan();
    try {
        await vi.waitFor(() => expect(f.published.inspect.mock.calls.length).toBe(before + 1));
        const view = await f.api.itemOperations('board', 'task');
        expect(view.operations.find(row => row.id === 'build')?.state).toBe('running');
        expect(f.published.inspect.mock.calls.length).toBe(before + 1); expect(f.published.start).toHaveBeenCalledOnce();
    } finally {release(); await scan;}
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
    await f.bind('deploy'); await f.run('build'); f.complete('build'); await f.api.scan(); await f.api.itemOperations('board', 'task');
    f.snapshot.version = 'changed'; await expect(f.run('deploy', 'deploy', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_SOURCE_CHANGED_REBUILD'});
    expect(f.published.start).toHaveBeenCalledOnce();
});
it('continues the original Session, requires every conflict choice, and invalidates stale analysis', async () => {
    const f = await fixture(); await f.acceptRuntime(); await f.run('analyze');
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original'})); expect(f.published.start).not.toHaveBeenCalled();
    await f.api.scan(); await f.api.itemOperations('board', 'task'); await f.bind('merge');
    await expect(f.run('merge', 'no-choice', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_SELECTION_REQUIRED'});
    f.snapshot.version = 'changed';f.snapshot.sourceVersion='changed-source';await expect(f.run('merge', 'stale-plan', {confirmed: true, selections: {file: 'integrate'}})).rejects.toMatchObject({code: 'OPERATION_SOURCE_CHANGED_REANALYZE'});
    f.snapshot.version='scope';f.snapshot.sourceVersion='source';await f.run('analyze','fresh-analysis');await f.api.scan();await f.run('merge', 'merge', {confirmed: true, selections: {file: 'integrate'}});
    const input = f.published.start.mock.calls[0][0] as never as {request: {source: {values: {context: string}}}};
    expect(JSON.parse(input.request.source.values.context).input).toMatchObject({approvalId: 'merge', analysisId: 'fresh-analysis', analysisDigest: sha256HexSync(JSON.stringify(f.plan)), selections: {file: 'integrate'}});
    f.complete('merge'); await f.api.scan(); const view = await f.api.itemOperations('board', 'task'); expect(view.operations.find(op => op.id === 'merge')).toMatchObject({state: 'succeeded', enabled: false});
});
it('checks the real running version before acceptance and journals canonical acceptance once', async () => {
    const f = await fixture(); await f.bind('build'); await f.bind('deploy'); await f.run('build'); f.complete('build'); await f.api.scan(); await f.api.itemOperations('board', 'task');
    f.published.inspect.mockResolvedValue({state: 'running'}); await f.run('deploy', 'deploy', {confirmed: true}); f.complete('deploy'); await f.api.scan(); await f.api.itemOperations('board', 'task');
    f.adapter.runningVersion.mockReturnValue('other'); await expect(f.run('accept', 'not-this-version', {confirmed: true})).rejects.toMatchObject({code: 'OPERATION_RUNNING_VERSION_MISMATCH'});
    f.adapter.runningVersion.mockReturnValue('candidate'); const view = await f.run('accept', 'accept', {confirmed: true});
    expect(f.service.execute).not.toHaveBeenCalled(); expect(f.item.status).toBe('review');
    await f.api.scan(); expect(f.service.execute).not.toHaveBeenCalled(); expect(view.operations.find(op => op.id === 'accept')?.state).toBe('succeeded');
});
it('refuses malformed output and does not enable dependent actions', async () => {
    const f = await fixture(); await f.bind('build'); await f.bind('deploy'); await f.run('build');
    f.published.inspect.mockResolvedValue({state: 'succeeded', output: {...f.result('build'), sourceVersion: 'somebody-else'}} as never);
    await f.api.scan(); const view = await f.api.itemOperations('board', 'task'); expect(view.operations.find(op => op.id === 'build')).toMatchObject({state: 'failed', code: 'OPERATION_RESULT_SCOPE_MISMATCH'});
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
    f.complete('build'); await f.api.scan(); await f.api.itemOperations('board', 'task'); expect(await f.api.guardResource('board', 'task', cleanup)).toBe('cleaned');
});
it('reconciles canonical accepted state after an acceptance reply was lost without replaying it', async () => {
    const f = await fixture();
    const job: ReviewJob = {id: 'accepted', action: 'accept', boardId: 'board', itemId: 'task', fingerprint: 'fingerprint', snapshot: {...f.snapshot}, phase: 'prepared', state: 'unknown', createdAt: 0, acceptanceVersion: 'old-service', command: {type: 'accept-execution', dispatchId: 'execution', accept: true}};
    await f.journal.update(jobKey(job.id), () => job); await f.journal.update(reviewKey('board', 'task'), () => ({revision: 1, bindings: {}, receipts: {}, jobs: [job.id]}));
    await f.journal.update('review-operation-scopes', () => [{board: 'board', item: 'task'}]);
    f.item.status = 'completed'; f.snapshot.version = 'now-changed'; f.service.workflow = async () => ({dispatches: {execution: {id: 'execution', itemId: 'task', attempt: 1, outcome: 'accepted'}}});
    await f.api.scan(); expect((await f.journal.get<ReviewJob>(jobKey(job.id)))!.state).toBe('succeeded'); expect(f.service.execute).not.toHaveBeenCalled();
});
it('settles a stale pending acceptance before sending any business command', async () => {
    const f = await fixture();
    const job: ReviewJob = {id: 'stale', action: 'accept', boardId: 'board', itemId: 'task', fingerprint: 'fingerprint', snapshot: {...f.snapshot}, phase: 'prepared', state: 'running', createdAt: 0, acceptanceVersion: 'candidate', command: {type: 'accept-execution', dispatchId: 'execution', accept: true}};
    await f.journal.update(jobKey(job.id), () => job);
    await f.journal.update(reviewKey('board', 'task'), () => ({revision: 1, bindings: {}, receipts: {}, jobs: [job.id]}));
    await f.journal.update('review-operation-scopes', () => [{board: 'board', item: 'task'}]);
    f.snapshot.version = 'changed'; await f.api.scan();
    expect(await f.journal.get(jobKey(job.id))).toMatchObject({phase: 'settled', state: 'failed', code: 'OPERATION_SOURCE_CHANGED_REBUILD'});
    expect(f.service.execute).not.toHaveBeenCalled();
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
    const queued=await f.api.itemOperations('board','task');expect(queued.operations.find(op=>op.id==='build')).toMatchObject({state:'running'});expect(queued.operations.find(op=>op.id==='deploy')).toMatchObject({hideRun:true});expect(f.published.start).toHaveBeenCalledOnce();
    await f.api.quiesce();const restored=createItemOperations(f.options);closes.push(()=>restored.quiesce());await restored.scan();
    expect(f.published.start).toHaveBeenCalledTimes(2);
    const settings=await f.journal.get<any>(reviewKey('board','task')),id=settings.jobs.at(-1);
    expect((await f.journal.get<ReviewJob>(jobKey('build-auto')))?.followUp).toMatchObject({state:'started',request:{operationId:id}});
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
 const f=await fixture();await f.bind('build');await f.bind('deploy');await f.run('build');f.complete('build');await f.api.scan();await f.api.itemOperations('board','task');
 const managed={operationId:'managed-deploy',serviceId:'host',expectedVersion:'old',targetVersion:'candidate'};
 const submit=vi.fn(async()=>{});f.options.adapter.managed={prepare:async()=>managed,submit,inspect:async()=>({state:'succeeded',output:{...f.result('managed-deploy'),status:'succeeded'}})};
 await f.run('deploy','managed-deploy',{confirmed:true});await f.api.scan();
 expect(submit).toHaveBeenCalledOnce();expect(f.published.start).toHaveBeenCalledOnce();expect(f.submission.start).not.toHaveBeenCalled();
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='deploy')).toMatchObject({state:'succeeded'});
});

it('accepts verified source delivery without requiring a deployed runtime and hides release actions',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['accept','analyze','merge','cleanup'],acceptance:'source'});
 const api=createItemOperations(f.options);closes.push(()=>api.quiesce());
 const view=await api.itemOperations('board','task');expect(view.operations.map(op=>op.id)).toEqual(['accept','analyze','merge']);
 await api.runItemOperation('board',{operationId:'accept-source',itemId:'task',action:'accept',expectedRevision:view.revision,confirmed:true});
 expect(f.service.execute).not.toHaveBeenCalled();expect(f.item.status).toBe('review');expect(f.adapter.runningVersion).not.toHaveBeenCalled();
 expect(await f.journal.get(jobKey('accept-source'))).toMatchObject({acceptanceScope:'source',state:'succeeded'});
});

it('keeps build-time replacement consent queued while paused and resumes once',async()=>{
 const f=await fixture(),board=await f.service.read();await f.bind('build');await f.bind('deploy');await f.run('build','pause-build',{followUp:'deploy'});f.complete('pause-build');
 (board as any).executionControl={paused:true};await f.api.scan();expect(f.published.start).toHaveBeenCalledOnce();
 expect((await f.journal.get<ReviewJob>(jobKey('pause-build')))?.followUp?.state).toBe('queued');
 (board as any).executionControl={paused:false};await f.api.scan();expect(f.published.start).toHaveBeenCalledTimes(2);
});
it('rechecks pause at the actual external admission after a long preparation',async()=>{
 const f=await fixture(),board=await f.service.read();
 f.options.adapter.prepareOperation=vi.fn(async()=>{(board as any).executionControl={paused:true};return {expectedSessionId:'original'} as never;});
 await f.run('build','slow-preparation');expect(f.submission.start).not.toHaveBeenCalled();
 expect(await f.journal.get(jobKey('slow-preparation'))).toMatchObject({phase:'prepared'});
 (board as any).executionControl={paused:false};await f.api.scan();expect(f.submission.start).toHaveBeenCalledOnce();
});

it('keeps a task in review until verified integration and then accepts the integrated source',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['analyze','merge','accept','cleanup'],acceptance:'source'});f.plan.conflicts=[];
 const api=createItemOperations(f.options);closes.push(()=>api.quiesce());
 const perform=async(action:string,id=action)=>api.runItemOperation('board',{operationId:id,itemId:'task',action,expectedRevision:(await api.itemOperations('board','task')).revision,confirmed:true});
 expect((await api.itemOperations('board','task')).operations.find(op=>op.id==='accept')?.enabled).toBe(true);
 await perform('accept');expect(f.item.status).toBe('review');
 await perform('analyze');await api.itemOperations('board','task');await f.bind('merge');
 await perform('merge');expect(f.item.status).toBe('review');expect(f.service.execute).not.toHaveBeenCalled();
 f.complete('merge');await api.scan();await api.itemOperations('board','task');
 expect(f.service.execute).toHaveBeenCalledOnce();expect(await f.journal.get(jobKey('accept'))).toMatchObject({acceptanceScope:'source',state:'succeeded'});
});

it('accepts the same deployed source after a verified target integration without rebuilding',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['build','deploy','analyze','merge','accept','cleanup'],acceptance:'runtime'});f.plan.conflicts=[];
 await f.bind('build');await f.bind('deploy');await f.bind('merge');
 await f.run('build');f.complete('build');await f.api.scan();await f.api.itemOperations('board','task');
 f.published.inspect.mockResolvedValue({state:'running'});await f.run('deploy','deploy',{confirmed:true});f.complete('deploy');await f.api.scan();await f.api.itemOperations('board','task');
 await f.run('accept','accept',{confirmed:true});expect(f.service.execute).not.toHaveBeenCalled();
 await f.run('analyze');await f.api.itemOperations('board','task');
 f.published.inspect.mockResolvedValue({state:'running'});await f.run('merge','merge',{confirmed:true});
 expect(f.service.execute).not.toHaveBeenCalled();expect(f.item.status).toBe('review');
 f.published.inspect.mockResolvedValue({state:'succeeded',output:{...f.result('merge'),targetHead:'integrated'}} as never);await f.api.scan();await f.api.itemOperations('board','task');
 f.snapshot.targetVersion='integrated';f.snapshot.version='integrated-scope';
 expect(f.service.execute).toHaveBeenCalledOnce();expect(await f.journal.get(jobKey('accept'))).toMatchObject({state:'succeeded',acceptanceVersion:'candidate',snapshot:{targetVersion:'target'}});
 expect(f.published.start).toHaveBeenCalledTimes(3);
});

it('requires replacement and acceptance before admitting submission',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['build','deploy','analyze','merge','accept','cleanup'],acceptance:'runtime'});f.plan.conflicts=[];
 await f.bind('merge');await expect(f.run('analyze')).rejects.toMatchObject({code:'OPERATION_PREREQUISITE_REQUIRED'});const view=await f.api.itemOperations('board','task');
 expect(view.operations.find(op=>op.id==='merge')?.enabled).toBe(false);expect(view.operations.find(op=>op.id==='accept')?.enabled).toBe(false);
});
it('freezes a separately proven compatible runtime on acceptance without rewriting old deployment receipts',async()=>{
 const f=await fixture();await f.bind('build');await f.bind('deploy');await f.run('build');f.complete('build');await f.api.scan();
 f.published.inspect.mockResolvedValue({state:'running'});await f.run('deploy','deploy',{confirmed:true});f.complete('deploy');await f.api.scan();
 f.adapter.runningVersion.mockReturnValue('newer');
 f.options.adapter.acceptanceVersion=async()=>({version:'newer',receipt:{previousVersion:'candidate',verified:true}});
 await f.run('accept','accept-newer',{confirmed:true});
 expect(await f.journal.get<ReviewJob>(jobKey('accept-newer'))).toMatchObject({state:'succeeded',acceptanceVersion:'newer',acceptanceEvidence:{previousVersion:'candidate'}});
 expect((await f.journal.get<ReviewJob>(jobKey('deploy')))?.result).toMatchObject({version:'candidate'});
});
it('projects persisted execution phases without pretending that a request is a completed build',async()=>{
 const f=await fixture();await f.acceptRuntime();expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='analyze')?.progress).toBeUndefined();
 f.submission.inspect.mockResolvedValue({sessionId:'original',outcome:'running'});
 const result=await f.run('analyze','progress-analysis');
 expect(result.operations.find(row=>row.id==='analyze')).toMatchObject({state:'running',progress:{stage:'running',requestedAt:expect.any(Number)}});
 expect(result.operations.find(row=>row.id==='analyze')?.reason).toBeUndefined();
 const job=await f.journal.get<ReviewJob>(jobKey('progress-analysis'));
 await f.journal.update<ReviewJob>(jobKey('progress-analysis'),()=>({...job!,state:'unknown',code:'TRANSPORT_DISCONNECTED'}));
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='analyze')?.progress?.stage).toBe('reconciling');
 await f.journal.update<ReviewJob>(jobKey('progress-analysis'),()=>({...job!,phase:'prepared',code:'WORKSPACE_CONTEXT_PENDING'}));
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='analyze')?.progress?.stage).toBe('waiting-context');
 expect(f.submission.start).toHaveBeenCalledOnce();
});
it('cancels the exact review operation without completing the task and preserves its original request',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build','cancel-build');
 const control=vi.fn(async()=> 'accepted' as 'accepted'|'cancelled');f.options.cancelOperation=control;
 let view=await f.api.itemOperations('board','task');
 const request={operationId:'stop-build',itemId:'task',action:'cancel',expectedRevision:view.revision,confirmed:true,cancel:{runId:'cancel-build'}};
 view=await f.api.runItemOperation('board',request);
 expect(view.operations.find(row=>row.id==='build')).toMatchObject({state:'cancelling',cancel:{enabled:false,state:'accepted'}});
 for(const id of ['deploy','accept','analyze','merge'])expect(view.operations.find(row=>row.id===id)).toMatchObject({state:'cancelling',enabled:false,hideRun:true});
 expect(view.halted).toMatchObject({runId:'cancel-build',state:'cancelling'});expect(f.item.status).toBe('review');
 const starts=f.published.start.mock.calls.length;control.mockResolvedValue('cancelled');await f.api.scan();
 view=await f.api.itemOperations('board','task');expect(view.operations.find(row=>row.id==='build')).toMatchObject({state:'cancelled',enabled:true});
 expect(view.halted?.state).toBe('cancelled');expect(f.item.status).toBe('review');expect(f.service.execute).not.toHaveBeenCalled();expect(f.published.start).toHaveBeenCalledTimes(starts);
 await f.api.runItemOperation('board',request);expect(control).toHaveBeenCalledTimes(2);
});
it('persists an unknown cancellation and resumes checking the same identity after restart',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build','unknown-build');
 const cancel=vi.fn().mockRejectedValueOnce(Object.assign(new Error('NETWORK'),{code:'TRANSPORT_DISCONNECTED'})).mockResolvedValue('cancelled');f.options.cancelOperation=cancel;
 const request={operationId:'stop-unknown',itemId:'task',action:'cancel',expectedRevision:(await f.api.itemOperations('board','task')).revision,confirmed:true,cancel:{runId:'unknown-build'}};
 expect((await f.api.runItemOperation('board',request)).operations.find(row=>row.id==='build')?.state).toBe('cancelling');
 await f.api.quiesce();const restored=createItemOperations(f.options);closes.push(()=>restored.quiesce());await restored.scan();
 expect((await restored.itemOperations('board','task')).operations.find(row=>row.id==='build')?.state).toBe('cancelled');
 expect(cancel.mock.calls.map(row=>row[1])).toEqual(['stop-unknown','stop-unknown']);expect(f.published.start).toHaveBeenCalledOnce();
});
it('allows cancellation while the original start reply is suspended and rejects a late completion overwrite',async()=>{
 const f=await fixture();await f.bind('build');let release!:(value:unknown)=>void;
 f.published.start.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));f.options.cancelOperation=vi.fn(async()=> 'cancelled');
 const starting=f.run('build','held-build');await vi.waitFor(()=>expect(f.published.start).toHaveBeenCalledOnce());
 const view=await f.api.itemOperations('board','task');
 const cancelled=await f.api.runItemOperation('board',{operationId:'stop-held',itemId:'task',action:'cancel',expectedRevision:view.revision,confirmed:true,cancel:{runId:'held-build'}});
 expect(cancelled.operations.find(row=>row.id==='build')?.state).toBe('cancelled');
 release({state:'succeeded',output:f.result('held-build')});await starting;
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='build')?.state).toBe('cancelled');expect(f.item.status).toBe('review');
});
it('does not cancel a newer run, skip confirmation, or claim managed switches are interruptible',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build','target-build');f.options.cancelOperation=vi.fn(async()=> 'cancelled');
 const request={operationId:'stop',itemId:'task',action:'cancel',expectedRevision:(await f.api.itemOperations('board','task')).revision,confirmed:true,cancel:{runId:'other-build'}};
 await expect(f.api.runItemOperation('board',request)).rejects.toMatchObject({code:'OPERATION_SCOPE_MISMATCH'});
 await expect(f.api.runItemOperation('board',{...request,cancel:{runId:'target-build'},confirmed:false})).rejects.toMatchObject({code:'OPERATION_CONFIRMATION_REQUIRED'});
 expect(f.options.cancelOperation).not.toHaveBeenCalled();
});
it('cancels a proven unstarted retry locally without invoking or replaying the executor',async()=>{
 const f=await fixture();await f.bind('build');f.published.start.mockRejectedValueOnce(Object.assign(new Error('Not started'),{code:'OPERATION_SESSION_OWNED',executionOutcome:'not-started',retryable:true}));
 await f.run('build','unstarted');const cancel=vi.fn(async()=> 'cancelled' as const);f.options.cancelOperation=cancel;
 const result=await f.api.runItemOperation('board',{operationId:'stop-unstarted',action:'cancel',itemId:'task',expectedRevision:(await f.api.itemOperations('board','task')).revision,confirmed:true,cancel:{runId:'unstarted'}});
 expect(result.operations.find(row=>row.id==='build')?.state).toBe('cancelled');expect(cancel).not.toHaveBeenCalled();await f.api.scan();expect(f.published.start).toHaveBeenCalledOnce();
});
it('allows a new human cancellation attempt only after authoritative rejection and retains its history',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build','rejected-stop-build');
 const cancel=vi.fn().mockRejectedValueOnce(Object.assign(new Error('Denied'),{code:'EACCES',cancelRejected:true})).mockResolvedValue('cancelled');f.options.cancelOperation=cancel;
 const request={operationId:'stop-one',action:'cancel',itemId:'task',expectedRevision:(await f.api.itemOperations('board','task')).revision,confirmed:true,cancel:{runId:'rejected-stop-build'}};
 const rejected=await f.api.runItemOperation('board',request);expect(rejected.operations.find(row=>row.id==='build')?.cancel?.state).toBe('failed');
 const result=await f.api.runItemOperation('board',{...request,operationId:'stop-two',expectedRevision:rejected.revision});
 expect(result.operations.find(row=>row.id==='build')?.state).toBe('cancelled');
 const receipt=await f.journal.get<{history:Array<{id:string;code:string}>}>('review-operation-cancel:rejected-stop-build');expect(receipt?.history).toContainEqual(expect.objectContaining({id:'stop-one',code:'EACCES'}));
});
it('explicitly refuses interruption of managed service replacement',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build');f.complete('build');await f.api.scan();
 const submit=vi.fn(async()=>{});f.options.adapter.managed={prepare:async()=>({operationId:'managed',serviceId:'server',expectedVersion:'old',targetVersion:'candidate'}),submit,inspect:async()=>({state:'running'})};
 await f.bind('deploy');const view=await f.run('deploy','managed',{confirmed:true});expect(view.operations.find(row=>row.id==='deploy')?.cancel).toMatchObject({enabled:false,reason:expect.any(String)});
 await expect(f.api.runItemOperation('board',{operationId:'stop-managed',action:'cancel',itemId:'task',expectedRevision:view.revision,confirmed:true,cancel:{runId:'managed'}})).rejects.toMatchObject({code:'OPERATION_CANCEL_UNSUPPORTED'});expect(submit).toHaveBeenCalledOnce();
});
it('never regresses a confirmed cancellation when a concurrent receipt check returns late',async()=>{
 const f=await fixture();await f.bind('build');await f.run('build','concurrent-build');let release!:(value:'accepted')=>void;
 const cancel=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;})).mockResolvedValue('cancelled');f.options.cancelOperation=cancel;
 const pending=f.api.runItemOperation('board',{operationId:'stop-concurrent',action:'cancel',itemId:'task',expectedRevision:(await f.api.itemOperations('board','task')).revision,confirmed:true,cancel:{runId:'concurrent-build'}});
 await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());await f.api.scan();
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='build')?.state).toBe('cancelled');
 release('accepted');await pending;expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='build')?.state).toBe('cancelled');
});

it('does not admit submission ahead of acceptance even for an older frozen release plan',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['build','deploy','analyze','merge','accept','cleanup'],acceptance:'runtime'});
 await f.bind('merge');const view=await f.api.itemOperations('board','task');
 expect(view.operations.find(row=>row.id==='analyze')).toMatchObject({enabled:false,dependsOn:['accept']});
 await expect(f.run('analyze')).rejects.toMatchObject({code:'OPERATION_PREREQUISITE_REQUIRED'});
 await expect(f.run('merge','early-merge',{confirmed:true,selections:{file:'integrate'}})).rejects.toMatchObject({code:'OPERATION_PREREQUISITE_REQUIRED'});
 expect(f.submission.start).not.toHaveBeenCalled();expect(f.published.start).not.toHaveBeenCalled();
});
it('allows runtime acceptance after replacement without requiring a merge in a frozen release plan',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({steps:['build','deploy','analyze','merge','accept','cleanup'],acceptance:'runtime'});
 await f.bind('build');await f.bind('deploy');await f.run('build');f.complete('build');await f.api.scan();
 f.published.inspect.mockResolvedValue({state:'running'});await f.run('deploy','deploy',{confirmed:true});f.complete('deploy');await f.api.scan();
 expect((await f.api.itemOperations('board','task')).operations.find(row=>row.id==='accept')).toMatchObject({enabled:true,dependsOn:['deploy']});
 await f.run('accept','independent-accept',{confirmed:true});expect(f.service.execute).not.toHaveBeenCalled();expect(f.item.status).toBe('review');
});

it.each(['EBUSY','PROCESS_READERS_BUSY'])('identifies proven workspace admission rejection %s before a review session starts and retains unknown failures',async remoteCode=>{
 const f=await fixture();await f.bind('build');
 f.adapter.snapshot.mockRejectedValueOnce(Object.assign(new Error('busy'),{code:'EIO',remoteCode,outcome:'not-committed'}));
 await expect(f.run('build','read-conflict')).rejects.toMatchObject({code:'OPERATION_WORKSPACE_BUSY',outcome:'not-committed'});
 expect(await f.journal.get(jobKey('read-conflict'))).toBeUndefined();expect(f.published.start).not.toHaveBeenCalled();
 f.adapter.snapshot.mockRejectedValueOnce(Object.assign(new Error('uncertain'),{code:'EIO',remoteCode:'EBUSY',outcome:'unknown'}));
 await expect(f.run('build','uncertain')).rejects.toMatchObject({code:'EIO',outcome:'unknown'});
});

it('retries failed post-merge cleanup without resending the merge or deleting Session history',async()=>{
 const f=await fixture();f.options.cleanup=vi.fn().mockRejectedValueOnce(Object.assign(Error('Dirty'),{code:'WORKTREE_DIRTY',cleanupPrecondition:true})).mockResolvedValue(true);
 await f.acceptRuntime();f.plan.conflicts=[];await f.bind('merge');await f.run('analyze');await f.api.scan();await f.run('merge','submit',{confirmed:true});
 f.complete('submit');await f.api.scan();
 let view=await f.api.itemOperations('board','task');
 expect(view.operations.find(row=>row.id==='merge')).toMatchObject({state:'failed',runAction:'cleanup',code:'WORKTREE_DIRTY',group:{id:'merge'}});
 const submissions=f.published.start.mock.calls.length;
 await f.api.scan();expect(f.options.cleanup).toHaveBeenCalledOnce();
 view=await f.run('cleanup','retry-cleanup');expect(view.operations.find(row=>row.id==='merge')?.state).toBe('succeeded');
 expect(f.options.cleanup).toHaveBeenCalledTimes(2);expect(f.published.start).toHaveBeenCalledTimes(submissions);
 expect(await f.journal.get(jobKey('analyze'))).toMatchObject({sessionId:'original'});
 await f.api.scan();expect(f.options.cleanup).toHaveBeenCalledTimes(2);expect(f.service.execute).toHaveBeenCalledOnce();
});
it('rejects analysis when the source changes after acceptance',async()=>{
 const f=await fixture();await f.acceptRuntime();f.snapshot.sourceVersion='changed';f.snapshot.version='changed';
 await expect(f.run('analyze')).rejects.toMatchObject({code:'OPERATION_SOURCE_CHANGED_REBUILD'});
 expect(f.submission.start).not.toHaveBeenCalled();expect(f.item.status).toBe('review');
});

it('requires fresh replacement and acceptance after a rebuild instead of reusing older success receipts',async()=>{
 const f=await fixture();await f.acceptRuntime();
 await f.run('build','rebuild');let view=await f.api.itemOperations('board','task');
 expect(view.operations.find(row=>row.id==='accept')).toMatchObject({enabled:false,state:'unavailable'});
 f.complete('rebuild');await f.api.scan();view=await f.api.itemOperations('board','task');
 expect(view.operations.find(row=>row.id==='deploy')).toMatchObject({enabled:true});
 f.published.inspect.mockResolvedValue({state:'running'});await f.run('deploy','redeploy',{confirmed:true});f.complete('redeploy');await f.api.scan();
 view=await f.api.itemOperations('board','task');expect(view.operations.find(row=>row.id==='accept')).toMatchObject({enabled:true});
 await f.run('accept','reaccept',{confirmed:true});
 expect(await f.journal.get(jobKey('accept'))).toMatchObject({state:'succeeded'});
 expect(await f.journal.get(jobKey('reaccept'))).toMatchObject({state:'succeeded'});
});

it('keeps the exact cleanup identity when reconciling an unknown external outcome',async()=>{
 const f=await fixture();f.options.cleanup=vi.fn().mockRejectedValueOnce(Object.assign(Error('Lost reply'),{code:'CLEANUP_OUTCOME_UNKNOWN'})).mockResolvedValue(true);
 expect(await finishReviewCleanup(f.options,'board','task','merged')).toBe(false);
 expect(await finishReviewCleanup(f.options,'board','task','merged')).toBe(false);
 expect(f.options.cleanup).toHaveBeenCalledOnce();
 expect(await finishReviewCleanup(f.options,'board','task','merged',true)).toBe(true);
 expect(vi.mocked(f.options.cleanup!).mock.calls[0][2]).toBe(vi.mocked(f.options.cleanup!).mock.calls[1][2]);
});

it('keeps management cleanup pending until every repository scope is finalized',async()=>{
 const f=await fixture(),board=await f.service.read();Object.assign(board,{items:[f.item],automation:{enabled:true}});
 Object.assign(f.item,{status:'completed',planning:{execution:'children'}});
 const scopes=[{id:'repo-a',label:'Repository',contributors:[],completed:false}];
 f.options.scopes={describe:async()=>({scopes}),resolve:async()=>({})};
 f.options.automatic=async()=>true;(f.service as any).catalog=async()=>[{id:'board'}];f.options.cleanup=vi.fn(async()=>true);
 const api=createItemOperations(f.options);closes.push(()=>api.quiesce());
 await api.scan();expect(f.options.cleanup).not.toHaveBeenCalled();
 expect(await api.finalizationStatus('board','task')).toMatchObject({state:'running',stage:'build'});
 scopes[0].completed=true;await api.scan();expect(f.options.cleanup).toHaveBeenCalledOnce();
 expect(await api.finalizationStatus('board','task')).toMatchObject({state:'completed'});
 expect(f.published.start).not.toHaveBeenCalled();
});

it('projects verified repository cleanup ahead of an older automatic target wait without rewriting receipts',async()=>{
 const f=await fixture(),legacy={id:'old',boardId:'board',itemId:'task',step:0,waitingForTarget:true,requests:{}};
 for(const ids of [['board','task'],['board','task','repo-a']])await f.journal.update('automatic-delivery:'+JSON.stringify(ids),()=>legacy);
 const scopes=[{id:'repo-a',label:'Repository',contributors:[],completed:true}];
 f.options.scopes={describe:async()=>({scopes}),resolve:async()=>({})};
 const api=createItemOperations(f.options);closes.push(()=>api.quiesce());
 expect(await api.finalizationStatus('board','task')).toEqual({state:'completed',stage:'completed'});
 const view=await api.itemOperations('board','task');
 expect(view.scopes?.[0].view.automatic).toEqual({state:'completed',stage:'completed'});
 expect(view.scopes?.[0].view.operations.every(operation=>!operation.enabled)).toBe(true);
 expect(await f.journal.get('automatic-delivery:'+JSON.stringify(['board','task']))).toEqual(legacy);
 expect(f.published.start).not.toHaveBeenCalled();expect(f.options.adapter.snapshot).not.toHaveBeenCalled();
 scopes.splice(0);expect(await api.finalizationStatus('board','task')).toMatchObject({state:'running',waitingForTarget:true});
});

it('preserves other repository controls when one scope cannot be read',async()=>{
 const f=await fixture();f.options.scopes={describe:async()=>({scopes:['unavailable','ready'].map(id=>({id,label:id,contributors:[]}))}),resolve:async(_b,_i,id)=>{
  if(id==='unavailable')throw Object.assign(Error('offline'),{code:'NATIVE_CONNECTION_FAILED'});return {deliveryPlan:async()=>({steps:['analyze'],acceptance:'source'})};
 }};
 const view=await f.api.itemOperations('board','task');
 expect(view.scopes![0].view).toMatchObject({operations:[],code:'NATIVE_CONNECTION_FAILED'});
 expect(view.scopes![1].view.operations[0]).toMatchObject({id:'analyze',enabled:true});
 expect(f.options.log).toHaveBeenCalledWith(expect.objectContaining({stage:'operation.scope.read',code:'NATIVE_CONNECTION_FAILED'}));
 expect(f.submission.start).not.toHaveBeenCalled();
});

it('projects configured scope order consistently for buttons, prerequisites and progress',async()=>{
 const f=await fixture();f.options.deliveryPlan=async()=>({ordering:'configured',steps:['analyze','merge','build','deploy','accept','cleanup'],acceptance:'runtime'});
 const view=await f.api.itemOperations('board','task');expect(view.operations.map(row=>row.id)).toEqual(['analyze','merge','build','deploy','accept']);
 expect(view.operations.find(row=>row.id==='analyze')).toMatchObject({dependsOn:[],enabled:true});
 expect(view.operations.find(row=>row.id==='build')).toMatchObject({dependsOn:['merge'],enabled:false});
});

it('distinguishes conflicts from an unmerged no-conflict plan and expires approval when the target changes',async()=>{
 const f=await fixture();await f.acceptRuntime();f.plan.conflicts=[];await f.run('analyze');await f.api.scan();await f.bind('merge');
 let view=await f.api.itemOperations('board','task');expect(view.operations.find(row=>row.id==='merge')?.statusText).toContain('无待决冲突');
 f.snapshot.version='new-target-state';
 await expect(f.run('merge','outdated-approval',{confirmed:true})).rejects.toMatchObject({code:'OPERATION_TARGET_CHANGED_REANALYZE'});
 view=await f.api.itemOperations('board','task');expect(view.code).toBe('OPERATION_TARGET_CHANGED_REANALYZE');
 expect(view.operations.find(row=>row.id==='merge')).toMatchObject({enabled:false,statusText:expect.stringContaining('已失效')});
 expect(view.operations.find(row=>row.id==='analyze')).toMatchObject({enabled:true,state:'ready',sessionId:'original'});
 expect(await f.journal.get(jobKey('analyze'))).toMatchObject({state:'succeeded',result:{conflicts:[]}});
 expect(await f.journal.get(jobKey('outdated-approval'))).toBeUndefined();expect(f.published.start).not.toHaveBeenCalled();
 f.snapshot.version='scope';await f.run('analyze','reanalysis');await f.api.scan();
 view=await f.api.itemOperations('board','task');expect(view.code).toBeUndefined();expect(view.operations.find(row=>row.id==='merge')?.enabled).toBe(true);
});
it('revokes the plan if the target changes between approval validation and request preparation',async()=>{
 const f=await fixture();await f.acceptRuntime();await f.run('analyze');await f.api.scan();await f.bind('merge');
 f.adapter.snapshot.mockResolvedValueOnce({...f.snapshot}).mockResolvedValueOnce({...f.snapshot,version:'raced',targetVersion:'raced-target'});
 await expect(f.run('merge','raced-approval',{confirmed:true,selections:{file:'integrate'}})).rejects.toMatchObject({code:'OPERATION_TARGET_CHANGED_REANALYZE'});
 expect((await f.api.itemOperations('board','task')).code).toBe('OPERATION_TARGET_CHANGED_REANALYZE');
 expect(await f.journal.get(jobKey('raced-approval'))).toBeUndefined();expect(f.published.start).not.toHaveBeenCalled();
});

it('stops before external merge admission when the target changes after the request was frozen',async()=>{
 const f=await fixture();await f.acceptRuntime();await f.run('analyze');await f.api.scan();await f.bind('merge');
 f.adapter.snapshot.mockResolvedValueOnce({...f.snapshot}).mockResolvedValueOnce({...f.snapshot}).mockResolvedValueOnce({...f.snapshot,version:'admission-drift'});
 const view=await f.run('merge','late-drift',{confirmed:true,selections:{file:'integrate'}});
 expect(f.published.start).not.toHaveBeenCalled();expect(view.code).toBe('OPERATION_TARGET_CHANGED_REANALYZE');
 expect(view.operations.find(row=>row.id==='analyze')).toMatchObject({enabled:true,state:'ready'});
 expect(view.operations.find(row=>row.id==='merge')).toMatchObject({enabled:false,state:'unavailable'});
 expect(await f.journal.get(jobKey('late-drift'))).toMatchObject({phase:'settled',state:'failed',code:'OPERATION_TARGET_CHANGED_REANALYZE'});
});

it('hands verified execution results to management automatically even when final integration is manual',async()=>{
 const f=await fixture(options=>{
  options.automatic=async()=>false;
  options.deliveryPlan=async()=>({steps:['accept'],acceptance:'source',acceptanceConfirmation:null});
  options.scopes={describe:async()=>({owner:{boardId:'board',itemId:'manager'},permittedActions:['accept','cancel']}),resolve:async()=>({}),handoff:async()=>({boardId:'board',itemId:'manager'})};
 });
 Object.assign(await f.options.service.read('board'),{automation:{enabled:true},items:[f.item]});
 f.options.service.catalog=async()=>[{id:'board'}] as never;
 const before=await f.api.itemOperations('board','task');
 expect(before.owner?.itemId).toBe('manager');expect(before.operations).toEqual([]);expect(f.service.execute).not.toHaveBeenCalled();
 for(let step=0;step<4;step++)await f.api.scan();
 expect(f.item.status).toBe('completed');expect(f.service.execute).toHaveBeenCalledOnce();
 expect(f.service.execute.mock.calls[0][1].command).toMatchObject({type:'accept-execution',dispatchId:'execution',accept:true});
 const after=await f.api.itemOperations('board','task');expect(after.operations).toEqual([]);
 expect(f.published.start).not.toHaveBeenCalled();expect(f.submission.start).not.toHaveBeenCalled();
});
it('keeps handoff failures actionable without presenting them as product acceptance',async()=>{
 const {readOperationScopes}=await import('../src/item-operation-scopes');
 const f=await fixture();f.options.scopes={describe:async()=>({owner:{boardId:'board',itemId:'manager'}}),resolve:async()=>({})};
 const view=await readOperationScopes(f.options,'board','task',async()=>({revision:'r',operations:[{id:'accept',label:'Acceptance',state:'failed',enabled:true,code:'EACCES',confirmation:'Confirm acceptance'}]}));
 expect(view.operations[0]).toMatchObject({id:'accept',group:{id:'handoff'},code:'EACCES'});expect(view.operations[0].confirmation).toBeUndefined();
 const blocked=await readOperationScopes(f.options,'board','task',async()=>({revision:'r',operations:[],automatic:{state:'blocked',stage:'accept',code:'EACCES'}}));
 expect(blocked.code).toBe('EACCES');
});

it('does not require a product acceptance checkbox to retry a proven source handoff',async()=>{
 const f=await fixture(options=>{options.deliveryPlan=async()=>({steps:['accept'],acceptance:'source',acceptanceConfirmation:null});});
 const view=await f.api.itemOperations('board','task');expect(view.operations[0].confirmation).toBeUndefined();
 await f.run('accept','handoff-retry');expect(f.service.execute).toHaveBeenCalledOnce();
});

async function automaticAnalysisFixture(){
 const f=await fixture(options=>{
  options.automatic=async()=>true;
  options.deliveryPlan=async()=>({ordering:'configured',steps:['analyze','merge','accept','cleanup'],acceptance:'source',acceptanceConfirmation:null});
  options.cleanup=vi.fn(async()=>true);options.reportAutomatic=vi.fn();
  options.adapter.prepareOperation=vi.fn(async input=>({expectedSessionId:'original',expectedBranch:'main',submission:{id:input.id,source:{kind:'conversation',ownerId:'original',id:input.id}}}));
  options.adapter.readOperation=vi.fn(async job=>job.action==='analyze'?{...job.snapshot,summary:'No unresolved choices',conflicts:[]}:{schema:'nestos.kanban.operation-result/1',operationId:job.id,status:'succeeded',sourceVersion:job.snapshot.sourceVersion,targetVersion:job.snapshot.targetVersion,targetHead:'merged'});
 });
 Object.assign(await f.options.service.read('board'),{automation:{enabled:true},items:[f.item]});
 f.options.service.catalog=async()=>[{id:'board'}] as never;
 return f;
}
async function scans(api:ReturnType<typeof createItemOperations>,count=10){for(let n=0;n<count;n++)await api.scan();}
const submittedActions=(f:Awaited<ReturnType<typeof automaticAnalysisFixture>>)=>f.submission.start.mock.calls.map(([request])=>request.submission.id.includes('-analyze')?'analyze':'merge');
it('automatically refreshes target drift, resumes the original Session and survives restart without extra verification',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);
 f.snapshot.version='target-2-state';f.snapshot.targetVersion='target-2';await f.api.scan();
 const saved=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task']));
 expect(saved).toMatchObject({step:0,revisionEpoch:expect.any(String)});expect(saved.code).toBeUndefined();
 await f.api.quiesce();const resumed=createItemOperations(f.options);closes.push(()=>resumed.quiesce());await scans(resumed);
 expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.submission.start.mock.calls.every(([request])=>request.expectedSessionId==='original')).toBe(true);
 const last=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task']));expect(last.revisionEpoch).toBe(saved.revisionEpoch);
 expect(f.item.status).toBe('completed');expect(f.options.reportAutomatic).not.toHaveBeenCalledWith(expect.objectContaining({code:'OPERATION_TARGET_CHANGED_REANALYZE'}));
});
it('reanalyses a source change in the configured integration chain without adding functional verification',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);
 f.snapshot.sourceVersion='source-2';f.snapshot.version='source-2-state';await scans(f.api);
 expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 const merge=f.submission.start.mock.calls.at(-1)![0],job=await f.journal.get<ReviewJob>(jobKey(merge.submission.id));
 expect(job?.snapshot.sourceVersion).toBe('source-2');expect(f.item.status).toBe('completed');
});
it('retries analysis after read-only version drift rather than requesting user confirmation',async()=>{
 const f=await automaticAnalysisFixture(),read=f.options.adapter.readOperation!;let stale=true;
 f.options.adapter.readOperation=vi.fn(async job=>{if(job.action==='analyze'&&stale){stale=false;f.snapshot.version='during-analysis';throw Object.assign(Error('changed'),{code:'MERGE_PLAN_SOURCE_CHANGED'});}return read(job);});
 await scans(f.api);expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.options.reportAutomatic).not.toHaveBeenCalledWith(expect.objectContaining({code:'MERGE_PLAN_SOURCE_CHANGED'}));
});
it('uses a formal not-started receipt for drift at merge admission and never resends the rejected request',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);
 const original={...f.snapshot};f.adapter.snapshot.mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockImplementationOnce(async()=>{f.snapshot.targetVersion='raced';f.snapshot.version='raced-state';return {...f.snapshot};});
 await f.api.scan();const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task'])),rejected=state.requests.merge.operationId;
 expect(await f.journal.get('review-merge-not-started:'+rejected)).toMatchObject({code:'OPERATION_TARGET_CHANGED_REANALYZE'});
 await scans(f.api);expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.submission.start.mock.calls.some(([request])=>request.submission.id===rejected)).toBe(false);
});
it('waits for the retained Session to become idle with the same analysis identity and without notifying the user',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);f.snapshot.version='drift';
 const prepare=f.options.adapter.prepareOperation!,attempts:string[]=[];let busy=true;
 f.options.adapter.prepareOperation=vi.fn(async input=>{if(input.action==='analyze'){attempts.push(input.id);if(busy){busy=false;throw Object.assign(Error('busy'),{code:'OPERATION_ORIGINAL_SESSION_BUSY'});}}return prepare(input);});
 await scans(f.api);expect(attempts).toHaveLength(2);expect(attempts[0]).toBe(attempts[1]);
 expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.options.reportAutomatic).not.toHaveBeenCalledWith(expect.objectContaining({code:'OPERATION_ORIGINAL_SESSION_BUSY'}));
});
it('never replaces an unknown merge with a fresh request when the target changes',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);
 f.submission.start.mockImplementation(async request=>{if(request.submission.id.includes('-merge'))throw Object.assign(Error('private transport error'),{code:'ETIMEDOUT'});return {sessionId:'original',outcome:'running'};});
 f.submission.inspect.mockResolvedValue({sessionId:'original',outcome:'unknown'});
 await f.api.scan();f.snapshot.version='changed-with-unknown';f.snapshot.targetVersion='new-target';
 const settings=await f.journal.get<any>(reviewKey('board','task'));
 await f.journal.update(reviewKey('board','task'),old=>({...old as any,invalidatedAnalysis:{id:settings.jobs[0],code:'OPERATION_TARGET_CHANGED_REANALYZE'}}));await scans(f.api);
 expect(submittedActions(f)).toEqual(['analyze','merge']);
 const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task']));expect(state.revisionEpoch).toBeUndefined();
 expect((await f.journal.get<ReviewJob>(jobKey(state.requests.merge.operationId)))?.phase).toBe('submitting');
});

it('does not treat a failed merge without a matching admission proof as unstarted',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);const original={...f.snapshot};
 f.adapter.snapshot.mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockImplementationOnce(async()=>{f.snapshot.version='unconfirmed-drift';return {...f.snapshot};});
 await f.api.scan();const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task']));
 await f.journal.update('review-merge-not-started:'+state.requests.merge.operationId,old=>({...old as object,fingerprint:'wrong-operation'}));
 await scans(f.api,4);expect(submittedActions(f)).toEqual(['analyze']);
 expect((await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task']))).revisionEpoch).toBeUndefined();
});

it('recovers a crash between the not-started receipt and runner settlement without inspecting or starting that merge',async()=>{
 const f=await automaticAnalysisFixture();await scans(f.api,2);const original={...f.snapshot};
 f.adapter.snapshot.mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockImplementationOnce(async()=>{f.snapshot.version='crash-window';return {...f.snapshot};});
 await f.api.scan();const state=await f.journal.get<any>('automatic-delivery:'+JSON.stringify(['board','task'])),id=state.requests.merge.operationId;
 await f.journal.update<ReviewJob>(jobKey(id),old=>({...old!,phase:'submitting',state:'unknown',code:undefined}));
 await f.api.quiesce();const resumed=createItemOperations(f.options);closes.push(()=>resumed.quiesce());await scans(resumed);
 expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.submission.inspect.mock.calls.some(([request])=>request.submission.id===id)).toBe(false);
 expect(f.options.log).toHaveBeenCalledWith(expect.objectContaining({stage:'operation.merge.admission-recovery',result:'success'}));
});

it('starts a ready management scope without a prior manual action and refreshes its analysis automatically',async()=>{
 const f=await automaticAnalysisFixture();Object.assign(f.item,{status:'open',planning:{execution:'children'}});let ready=false,cleaned=false;
 f.options.scopes={describe:async()=>({scopes:[{id:'repository-auto',label:'Repository',contributors:[],ready,completed:cleaned}]}),resolve:async()=>({adapter:{...f.options.adapter,ready:()=>ready}})};
 f.options.cleanup=vi.fn(async()=>{cleaned=true;return true;});
 const before=await f.api.itemOperations('board','task');expect(before.scopes).toHaveLength(1);
 await f.api.scan();expect(f.submission.start).not.toHaveBeenCalled();
 ready=true;await scans(f.api,2);expect(submittedActions(f)).toEqual(['analyze']);
 f.snapshot.version='scope-target-drift';f.snapshot.targetVersion='new-target';await scans(f.api);
 expect(submittedActions(f)).toEqual(['analyze','analyze','merge']);
 expect(f.submission.start.mock.calls.every(([request])=>request.expectedSessionId==='original')).toBe(true);
 expect(await f.journal.get('automatic-delivery:'+JSON.stringify(['board','task','repository-auto']))).toMatchObject({step:4});
});

it('only retires a proven independent legacy finalizer for the same software target',async()=>{
 const {releasableDevelopmentFinalizer}=await import('../src/development-operation-policy');
 const item={id:'old',status:'completed',planning:{execution:'children'},externalRefs:[{system:'nestos-remote-project',id:'project'}]};
 const options={service:{read:async()=>({id:'board'}),item:async()=>({item})},adapter:{supports:()=>true}} as any;
 const scope={id:'auto',boardId:'board',itemId:'old',target:'project'},state={id:'auto',executionId:'old',steps:['cleanup'],step:0,cleanupPrecondition:true} as any;
 expect(await releasableDevelopmentFinalizer(options,scope,state)).toBe(true);
 expect(await releasableDevelopmentFinalizer(options,{...scope,target:'other-project'},state)).toBe(false);
 expect(await releasableDevelopmentFinalizer({...options,adapter:{}},scope,state)).toBe(false);
 item.status='backlog';expect(await releasableDevelopmentFinalizer(options,scope,state)).toBe(false);
});

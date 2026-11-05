import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {memoryChannels} from './helpers/session-channels';
import {sha256HexSync} from '@nestos/common';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {readPrompt} from '../src/run/prompt-bundle';
import {developmentReviewAdapter} from '../src/presets/kanban-development-review';
const mock = vi.hoisted(() => ({dirty: false, busy: false, context: true, process: {}}));
vi.mock('../src/presets/kanban-development-workspace', () => ({developmentWorkspace: async (_remote, _provider, _project, work) => work(mock.process)}));
vi.mock('../src/presets/kanban-work-resource-execution', () => ({workResourceExecution: async () => mock.busy ? ['OPERATION_ORIGINAL_SESSION_BUSY'] : []}));
vi.mock('../src/projects/worktree-status', () => ({inspectWorktree: async () => ({exists: true, head: 'source-head', targetHead: 'target-head', targetBranch: 'main'})}));
vi.mock('../src/projects/worktree-modules', () => ({gitWorkspace: async () => ({stdout: mock.dirty ? ' M file' : ''}), verifyWorktreeDelivery: async () => [{path: '.', fingerprint: 'delivery'}]}));
vi.mock('../src/projects/harness-context-catalog', () => ({readContextCatalog: async () => ({value: {bindings: {original: {id: 'binding', branchId: 'main', connectionId: 'work-original', validity: mock.context ? 'valid' : 'invalid', nativeRef: {profileId: 'codex', sessionId: 'original-native'}, revision: 7, generation: 2}}}})}));
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); mock.dirty = mock.busy = false; mock.context = true;});
async function fixture(withExchange = false) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open();
    await journal.update('worktree:original', () => ({id: 'original', directory: '/workspace/_nestos/worktrees/original', branch: 'work/original', phase: 'ready'}));
    await journal.update('development-workspace:original', () => ({directory: '/workspace/_nestos/worktrees/original', projectId: 'project', context: {board: {id: 'board'}, task: {id: 'task'}}, policy: {profile: 'development', commit: 'changes', modules: []}}));
    const item = {id: 'task', title: 'Task', responsibility: 'Work', acceptance: 'Verify', externalRefs: [{system: 'nestos-worktree', id: 'original'}, {system: 'nestos-remote-project', id: 'project'}]}, board = {id: 'board'};
    const target = {kind: 'agent', id: 'original-agent', version: '1', digest: 'original-digest'};
    const calls = {list: vi.fn(async () => [{receipt: {executionSessionId: 'original-session'}, callerState: {settled: true}, executionTree: {settled: true}, input: {request: {expectedTarget: target, expectedBranch: 'main', overrides: {connection: 'original-connection'}}}}])};
    let outcome: 'running' | 'succeeded' = 'running';
    const submission = {start: vi.fn(async () => ({sessionId: 'original-session', outcome})), inspect: vi.fn(async () => ({sessionId: 'original-session', outcome}))};
    const channels=memoryChannels();
    const stop = vi.fn(), close = vi.fn(async () => {}), remote = {sessionChannel:channels.channel,projectHarness: async () => ({subscribeChannel: () => stop, close})};
    const api = developmentReviewAdapter({fs, journal, calls, remote, submission: withExchange ? submission : undefined, kernel: {sessionActivity: async () => ({counts: {}})}, projects: {get: async () => ({path: '/project'}), openWorkspace: async () => ({fs, dispose: async () => {}})}, runningVersion: 'running', service: {execute: async () => {}, workflow: async () => ({dispatches: {}}), read: async () => board, item: async () => ({item})}} as never);
    closes.push(() => api.close!());
    return {api, journal, fs, channels, submission, stop, close, complete: () => {outcome = 'succeeded';}, item: item as never, board: board as never, target, calls};
}
it('prepares merge analysis in the original logical Session and exact native context without executing it', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis', board: f.board, item: f.item, snapshot});
    expect(request).toMatchObject({expectedSessionId: 'original-session', expectedTarget: f.target, overrides: {branchMode: 'continue', harnessConversation: {mode: 'resume', bindingId: 'binding', expectedBindingRevision: 7, expectedGeneration: 2}}});
    expect(request.source).toMatchObject({kind: 'composer', text: expect.stringContaining('READ-ONLY')});
    expect(await f.journal.get('worktree:analysis')).toMatchObject({id: 'original'});
    const bundle = (await f.journal.get<{prompts: {files: Array<{name: string}>}}>('development-policy:analysis'))!;
    expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-pre.md'); expect(bundle.prompts.files.map(row => row.name)).toContain('task-merge-post.md');
    expect(await f.fs.driver.exists('/workspace/_nestos/worktrees/original/_nestos/kanban/review/analysis/manifest.json')).toBe(true);
    expect(f.calls.list).toHaveBeenCalledWith({sessionId: 'original'});
});
it('refuses a dirty target, busy original session and invalid native binding', async () => {
    const f = await fixture(); mock.dirty = true; await expect(f.api.snapshot(f.board, f.item)).rejects.toMatchObject({code: 'OPERATION_TARGET_DIRTY'});
    mock.dirty = false; const snapshot = await f.api.snapshot(f.board, f.item);
    mock.busy = true; await expect(f.api.prepareAnalysis({id: 'busy', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_SESSION_BUSY'});
    mock.busy = false; mock.context = false; await expect(f.api.prepareAnalysis({id: 'invalid', board: f.board, item: f.item, snapshot})).rejects.toMatchObject({code: 'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE'});
    expect(await f.journal.get('worktree:busy')).toBeUndefined();
});

it('publishes context replies and resumes merge analysis in the original Session through the real adapter', async () => {
    const f = await fixture(true), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareAnalysis({id: 'analysis', board: f.board, item: f.item, snapshot});
    const job = {id: 'analysis', boardId: 'board', itemId: 'task', request, snapshot} as never;
    f.channels.request('analysis','request','unsupported.context',{});
    expect(await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'})).toMatchObject({outcome: 'running', code: 'WORKSPACE_CONTEXT_PENDING'});
    expect(f.channels.ensure('analysis').requests[0].response).toMatchObject({id:'request',status:'error',error:{code:'CHANNEL_METHOD_UNSUPPORTED'}});
    expect(f.submission.start).toHaveBeenCalledWith(expect.objectContaining({expectedSessionId: 'original-session', overrides: expect.objectContaining({harnessConversation: expect.objectContaining({mode: 'resume', bindingId: 'binding', expectedGeneration: 2})})}));
    f.complete(); expect(await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'})).toMatchObject({outcome: 'succeeded'});
    await f.api.exchange!(job, {sessionId: 'original-session', outcome: 'succeeded'}); expect(f.submission.start).toHaveBeenCalledOnce();
});
it('prepares project-discovered builds in the original Session and freezes maintenance prompts', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareOperation!({id: 'build', action: 'build', board: f.board, item: f.item, snapshot});
    expect(request.expectedSessionId).toBe('original-session'); expect((request.source as {text: string}).text).toContain('Discover project commands');
    const path = '/workspace/_nestos/worktrees/original/_nestos/kanban/review/build';
    const manifest = JSON.parse(await readPrompt(f.fs, path + '/manifest.json'));
    expect(manifest.context.phase).toBe('build'); expect(manifest.files.map(row => row.name)).toContain('task-build-pre.md');
    const job = {id: 'build', action: 'build', boardId: 'board', itemId: 'task', request, snapshot} as never;
    f.channels.report('build','result',{type:'result',content:'Build result',payload:{status:'succeeded'}});
    await expect(f.api.readOperation!(job)).rejects.toMatchObject({code: 'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
});

it('reads a successful original-session build only with a matching immutable artifact receipt', async () => {
    const f = await fixture(), snapshot = await f.api.snapshot(f.board, f.item);
    const request = await f.api.prepareOperation!({id: 'build-ok', action: 'build', board: f.board, item: f.item, snapshot});
    const directory = '/workspace/_nestos/worktrees/original';
    const receipt = JSON.stringify({version: 'candidate', checks: ['project build completed']});
    await f.fs.driver.createFile({parentPath: directory, name: 'build-receipt.json', content: receipt});
    const payload = {schema: 'nestos.kanban.operation-result/1', operationId: 'build-ok', status: 'succeeded', sourceVersion: snapshot.sourceVersion, targetVersion: snapshot.targetVersion, version: 'candidate', evidence: {path: 'build-receipt.json', sha256: sha256HexSync(receipt)}};
    f.channels.report('build-ok','result',{type:'result',content:'Build result',payload});
    expect(await f.api.readOperation!({id: 'build-ok', action: 'build', boardId: 'board', itemId: 'task', request, snapshot} as never)).toEqual(payload);
});

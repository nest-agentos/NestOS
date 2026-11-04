import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanClient, KanbanDeletionRequest, KanbanWorkResource} from '@nestos/kanban/contracts';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {createBoardDeletion, withBoardDeletion} from '../src/kanban/board-deletion';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs); await journal.open();
    let check: () => Promise<void> = async () => {};
    const core = createKanbanModule({store, actor: {kind: 'human', id: 'admin'}, authorize: async () => {}, verifyDeletion: () => check(), log: vi.fn()});
    await core.create({id: 'b', title: 'PRIVATE_TITLE', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['coordinator', 'worker']}], policy: {requireEstimate: false}});
    await core.execute('b', {operationId: 'task', expectedRevision: 1, command: {type: 'create-item', item: {id: 't', title: 'Task', responsibility: 'Work', acceptance: 'Done'}}});
    const resources: KanbanWorkResource[] = [], cleanup = vi.fn(async (_board: string, request) => {const resource = resources.find(row => row.id === request.resourceId)!; resource.state = 'cleaned'; resource.canCleanup = false; return resource;});
    const session = vi.fn(async () => ({history: [], sessions: []}));
    const service: KanbanClient = {...core, workResources: async () => structuredClone(resources), cleanupWorkResource: cleanup, executionSession: session};
    const deletion = createBoardDeletion({service, journal}); check = () => deletion.assertSettled('b');
    const api = withBoardDeletion(service, deletion);
    const request = async (): Promise<KanbanDeletionRequest> => {const preview = await api.previewDeletion('b'); return {operationId: 'remove', version: preview.version, expectedRevision: preview.revision, cleanup: true};};
    return {core, service, api, journal, resources, cleanup, session, request, deletion};
}
function resource(id: string, canCleanup: boolean): KanbanWorkResource {return {id, kind: 'worktree', title: id, location: '/' + id, state: canCleanup ? 'cleanup-ready' : 'retained', reasons: canCleanup ? [] : ['WORKTREE_UNMERGED'], version: 'a'.repeat(64), properties: [], canCleanup};}
it('cleans only eligible resources, retains provenance and replays lost deletion replies without side effects', async () => {
    const f = await fixture(); f.resources.push(resource('ready', true), resource('dirty', false));
    const request = await f.request(); await f.api.deleteBoard('b', request);
    expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.cleanup.mock.calls[0][1].resourceId).toBe('ready');
    expect((await f.core.read('b')).deletedAt).toBeTypeOf('number'); expect(await f.api.catalog()).toEqual([]);
    await createBoardDeletion({service: f.service, journal: f.journal}).deleteBoard('b', request);
    expect(f.cleanup).toHaveBeenCalledOnce();
    const saved = await f.journal.get<{preview: {resources: unknown[]}}>('board-deletion:b'); expect(saved?.preview.resources).toHaveLength(2);
    expect(await f.api.workResources!('b', 't')).toHaveLength(2);
});
it('rejects stale previews and bypassing confirmation', async () => {
    const f = await fixture(), request = await f.request();
    await f.api.execute('b', {operationId: 'change', expectedRevision: 2, command: {type: 'register-session', sessionId: 'new', role: 'observer', subscribed: false}});
    await expect(f.api.deleteBoard('b', request)).rejects.toMatchObject({code: 'BOARD_DELETE_PREVIEW_CHANGED'});
    await expect(f.api.execute('b', {operationId: 'bypass', expectedRevision: 3, command: {type: 'delete-board'}})).rejects.toMatchObject({code: 'BOARD_DELETE_CONFIRMATION_REQUIRED'});
    expect(f.cleanup).not.toHaveBeenCalled();
});
it('shows pending maintenance and decisions and refuses deletion', async () => {
    const f = await fixture();
    await f.journal.update('review-operation:job', () => ({boardId: 'b', itemId: 't', phase: 'submitting'}));
    await f.journal.update('record-runs:another', () => [{sourceBoardId: 'another', boardId: 'b', state: 'running'}]);
    const preview = await f.api.previewDeletion('b');
    expect(preview.blockers.map(row => row.code)).toEqual(expect.arrayContaining(['BOARD_MAINTENANCE_ACTIVE', 'BOARD_DECISION_UNSETTLED']));
    await expect(f.api.deleteBoard('b', await f.request())).rejects.toMatchObject({code: 'BOARD_MAINTENANCE_ACTIVE'});
    expect((await f.api.read('b')).deletedAt).toBeUndefined();
});
it('waits for admitted scans and rechecks Session activity at the commit boundary', async () => {
    const f = await fixture(), request = await f.request();
    let release!: () => void; const barrier = new Promise<void>(resolve => {release = resolve;});
    const scan = vi.fn(() => barrier), api = withBoardDeletion({...f.service, scan}, f.deletion);
    const pendingScan = api.scan(), pendingDelete = api.deleteBoard('b', request);
    await vi.waitFor(() => expect(scan).toHaveBeenCalled()); expect((await f.core.read('b')).deletedAt).toBeUndefined();
    f.session.mockResolvedValue({history: [], sessions: [{sessionId: 'native', stale: false, state: 'running', executions: []}]} as never);
    release(); await pendingScan;
    await expect(pendingDelete).rejects.toMatchObject({code: 'BOARD_DELETE_PREVIEW_CHANGED'});
    const preview = await api.previewDeletion('b'); expect(preview.blockers[0]).toMatchObject({code: 'BOARD_SESSION_UNSETTLED', sessionId: 'native'});
});
it('preserving worktrees skips cleanup, and cleanup failure never deletes the board', async () => {
    const f = await fixture(); f.resources.push(resource('ready', true));
    f.cleanup.mockRejectedValueOnce(Object.assign(new Error('node offline'), {code: 'WORK_RESOURCE_NODE_BUSY'}));
    await expect(f.api.deleteBoard('b', await f.request())).rejects.toMatchObject({code: 'WORK_RESOURCE_NODE_BUSY'});
    expect((await f.api.read('b')).deletedAt).toBeUndefined();
    const request = {...await f.request(), operationId: 'preserve', cleanup: false}; await f.api.deleteBoard('b', request);
    expect(f.cleanup).toHaveBeenCalledOnce(); expect(f.resources[0].state).toBe('cleanup-ready');
});
it('retains a board while fix clarification or user reply admission is unsettled', async () => {
    const f = await fixture();
    await f.journal.update('fix-index', () => ['fix']); await f.journal.update('fix:fix', () => ({boardId: 'b', itemId: 't', accepted: false}));
    await f.journal.update('task-reply-index', () => ['reply']); await f.journal.update('task-reply:reply', () => ({boardId: 'b', request: {itemId: 't'}}));
    expect((await f.api.previewDeletion('b')).blockers.map(row => row.code)).toEqual(expect.arrayContaining(['BOARD_FIX_UNSETTLED', 'BOARD_REPLY_UNSETTLED']));
    await expect(f.api.deleteBoard('b', await f.request())).rejects.toMatchObject({code: 'BOARD_FIX_UNSETTLED'});
    await f.journal.update('fix:fix', () => ({boardId: 'b', itemId: 't', accepted: true})); await f.journal.update('task-reply-delivered:reply', () => true);
    expect((await f.api.previewDeletion('b')).blockers).toEqual([]);
    await f.api.deleteBoard('b', await f.request()); expect((await f.api.read('b')).deletedAt).toBeTypeOf('number');
});
it('keeps new fix and reply ports inside the existing deletion admission boundary', async () => {
    const f = await fixture(), fixTask = vi.fn(), replyTask = vi.fn(), api = withBoardDeletion({...f.service, fixTask, replyTask}, f.deletion);
    await api.deleteBoard('b', await f.request());
    await expect(api.fixTask('b', {itemId: 't', operationId: 'fix'})).rejects.toMatchObject({code: 'BOARD_DELETED'});
    await expect(api.replyTask('b', {itemId: 't', attemptId: 'attempt', replyTo: 'question', content: 'reply', operationId: 'reply'})).rejects.toMatchObject({code: 'BOARD_DELETED'});
    expect(fixTask).not.toHaveBeenCalled(); expect(replyTask).not.toHaveBeenCalled();
});

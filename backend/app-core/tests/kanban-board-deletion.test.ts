import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanClient, KanbanDeletionRequest, KanbanWorkResource} from '@nestos/kanban/contracts';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createBoardDeletion, withBoardDeletion} from '@nestos/kanban/integration';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open();
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
it('returns display names and queries the item catalog only once per preview', async () => {
    const f = await fixture(), query = vi.spyOn(f.service, 'query');
    const preview = await f.api.previewDeletion('b');
    expect(preview.itemTitles).toEqual({t: 'Task'}); expect(query).toHaveBeenCalledOnce();
});
it('cleans a shared resource once and only when every item association permits cleanup', async () => {
    const f = await fixture(); f.resources.push(resource('shared', true));
    await f.core.execute('b', {operationId: 'another', expectedRevision: 2, command: {type: 'create-item', item: {id: 'second', title: 'Second', responsibility: 'Work', acceptance: 'Done'}}});
    expect((await f.api.previewDeletion('b')).resources).toHaveLength(2);
    await f.api.deleteBoard('b', await f.request()); expect(f.cleanup).toHaveBeenCalledOnce();
    const g = await fixture();
    await g.core.execute('b', {operationId: 'another', expectedRevision: 2, command: {type: 'create-item', item: {id: 'second', title: 'Second', responsibility: 'Work', acceptance: 'Done'}}});
    g.service.workResources = async (_board, item) => [resource('shared', item === 't')];
    await g.api.deleteBoard('b', await g.request()); expect(g.cleanup).not.toHaveBeenCalled();
});
it('bounds parallel execution checks and drains in-flight reads after a failure', async () => {
    const f = await fixture();
    for (let index = 0; index < 7; index++) await f.core.execute('b', {operationId: 'add-' + index, expectedRevision: index + 2,
        command: {type: 'create-item', item: {id: 't' + index, title: 'Task ' + index, responsibility: 'Work', acceptance: 'Done'}}});
    let active = 0, peak = 0;
    f.service.executionSession = async (_board, item) => {
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5)); active--;
        if (item === 't') throw Object.assign(new Error('PRIVATE_BODY'), {code: 'REMOTE_OFFLINE'});
        return {history: [], sessions: []};
    };
    await expect(f.api.previewDeletion('b')).rejects.toMatchObject({code: 'REMOTE_OFFLINE'});
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4); expect(active).toBe(0);
});
it('signals an active scanner before waiting for its acknowledgement and never disposes it early', async () => {
    const f = await fixture(); let release!: () => void, started!: () => void, settled = false;
    const entered = new Promise<void>(resolve => {started = resolve;});
    const scan = vi.fn(async () => {started(); await new Promise<void>(resolve => {release = resolve;}); settled = true;});
    const quiesce = vi.fn(async () => {release();}), dispose = vi.fn(async () => {expect(settled).toBe(true);});
    const api = withBoardDeletion({...f.service, scan, quiesce, dispose}, f.deletion);
    const pending = api.scan(); await entered;
    await api.quiesce(); await pending;
    expect(quiesce).toHaveBeenCalledOnce(); expect(settled).toBe(true); expect(dispose).not.toHaveBeenCalled();
    await api.dispose(); expect(dispose).toHaveBeenCalledOnce(); expect(quiesce).toHaveBeenCalledOnce();
});

it('retains unknown and foreign resources without blocking logical deletion or cleaning them', async () => {
    const f=await fixture();
    f.resources.push({...resource('unknown',false),ownership:'unknown',state:'unknown',reasons:['WORKTREE_ASSOCIATION_UNKNOWN']},
        {...resource('foreign',true),ownership:'other',state:'in-use',reasons:['WORKTREE_OTHER_OWNER']});
    expect((await f.api.previewDeletion('b')).blockers).toEqual([]);
    await f.api.deleteBoard('b',await f.request());
    expect(f.cleanup).not.toHaveBeenCalled();
    expect((await f.api.read('b')).deletedAt).toBeTypeOf('number');
    expect((await f.journal.get<{preview:{resources:unknown[]}}>('board-deletion:b'))?.preview.resources).toHaveLength(2);
});
it('still blocks unsettled execution when all resource ownership is unknown', async () => {
    const f=await fixture();f.resources.push({...resource('unknown',false),ownership:'unknown',state:'unknown'});
    await f.core.execute('b',{operationId:'claim',expectedRevision:2,command:{type:'claim',itemId:'t'}}).catch(async () => {
        await f.core.execute('b',{operationId:'ready',expectedRevision:2,command:{type:'set-stage',itemId:'t',stage:'open'}});
        await f.core.execute('b',{operationId:'claim-ready',expectedRevision:3,command:{type:'claim',itemId:'t'}});
    });
    const preview=await f.api.previewDeletion('b');expect(preview.blockers).toContainEqual({code:'BOARD_EXECUTION_ACTIVE',itemId:'t'});
    await expect(f.api.deleteBoard('b',await f.request())).rejects.toMatchObject({code:'BOARD_EXECUTION_ACTIVE'});
});
it('does not treat unrelated discussion or a shared Session new turn as this board execution', async () => {
    const f=await fixture();
    f.session.mockResolvedValue({history:[],sessions:[{sessionId:'discussion',state:'running',stale:false,purposes:['discussion'],executions:[]},
        {sessionId:'shared',state:'running',stale:false,purposes:['execution'],executions:[{id:'original',purpose:'execution',state:'completed'}]}]} as never);
    expect((await f.api.previewDeletion('b')).blockers).toEqual([]);
    await f.api.deleteBoard('b',await f.request());
    expect((await f.api.read('b')).deletedAt).toBeTypeOf('number');
});

it('persists pending deletion, freezes new work and automatically deletes only after the original blocker settles across restart',async()=>{
    const f=await fixture();f.resources.push({...resource('unknown',false),ownership:'unknown',state:'unknown'});
    f.session.mockResolvedValue({history:[],sessions:[{sessionId:'original',state:'running',stale:false,executions:[]}]} as never);
    const request={...await f.request(),mode:'drain' as const};
    await f.api.requestBoardDeletion!('b',request);
    expect((await f.api.read('b')).lifecycle).toMatchObject({intent:'delete',mode:'drain',phase:'waiting'});
    expect((await f.api.read('b')).executionControl).toMatchObject({paused:true,mode:'manual'});
    await expect(f.api.execute('b',{operationId:'new-work',expectedRevision:(await f.api.read('b')).revision,command:{type:'request-run',itemId:'t'}})).rejects.toMatchObject({code:'BOARD_STOPPING'});
    const restored=withBoardDeletion(f.service,createBoardDeletion({service:f.service,journal:f.journal}));
    await restored.scan();expect((await restored.read('b')).deletedAt).toBeUndefined();
    expect((await restored.previewDeletion('b')).pendingDeletion).toMatchObject({operationId:request.operationId,phase:'blocked'});
    f.session.mockResolvedValue({history:[],sessions:[{sessionId:'original',state:'completed',stale:false,executions:[]}]} as never);
    await restored.scan();
    expect((await restored.read('b')).deletedAt).toBeTypeOf('number');
    expect(f.cleanup).not.toHaveBeenCalled();expect(await restored.catalog()).toEqual([]);
    expect(await f.journal.get('board-stop:b')).toMatchObject({phase:'done'});
});
it('whole-board cancellation freezes scheduling and cancels original tasks without deleting the board',async()=>{
    const f=await fixture();
    await f.core.execute('b',{operationId:'plan',expectedRevision:2,command:{type:'publish-plan',plan:{schema:'kanban.plan/1',id:'p',revision:1,sealed:true,items:[{id:'t',expectedRevision:1,title:'Task',responsibility:'Work',acceptance:'Done',assignee:{kind:'human',id:'admin'},dependsOn:[]}]}}});
    await f.core.execute('b',{operationId:'dispatch',expectedRevision:(await f.core.read('b')).revision,command:{type:'prepare-dispatch',itemId:'t',dispatchId:'original'}});
    await f.api.cancelBoard!('b',{operationId:'cancel-board',expectedRevision:(await f.api.read('b')).revision});
    expect((await f.api.item('b','t')).item.control?.action).toBe('cancel');
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[{receipt:{executionSessionId:'original'},input:{request:{submission:{id:'original'}}},callerState:{settled:true},executionTree:{settled:true}}] as never}},f.journal),f.journal,await f.core.read('b'),f.core);
    await f.api.scan();
    const board=await f.api.read('b');
    expect(board.lifecycle).toMatchObject({intent:'cancel',phase:'ready'});expect(board.deletedAt).toBeUndefined();
    expect(board.items[0].status).toBe('cancelled');
});

it('upgrades a cancelled board to deferred deletion without allowing its old stop receipt to discard the delete request',async()=>{
    const f=await fixture();
    await f.api.cancelBoard!('b',{operationId:'cancel-board',expectedRevision:(await f.api.read('b')).revision});
    const control=(await f.api.item('b','t')).item.control!;
    await f.core.execute('b',{operationId:'cancelled',expectedRevision:(await f.core.read('b')).revision,command:{type:'control-receipt',itemId:'t',controlId:control.id,state:'cancelled'}});
    await f.api.scan();expect((await f.api.read('b')).deletedAt).toBeUndefined();
    const preview=await f.api.previewDeletion('b');
    await f.api.requestBoardDeletion!('b',{operationId:'delete-later',expectedRevision:preview.revision,version:preview.version,cleanup:false,mode:'drain'});
    expect(await f.journal.get('board-stop:b')).toMatchObject({request:{operationId:'delete-later'},phase:'admitted'});
    await f.api.scan();expect((await f.api.read('b')).deletedAt).toBeTypeOf('number');
});

import {kanbanControlOptions} from '../src/kanban/control-adapter';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule} from '@nestos/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import type {KanbanCommand, KanbanWorkType} from '@nestos/kanban/contracts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createRecordExecution} from '@nestos/kanban/integration';
import {validateRemoteReferences, projectResourceCatalog} from '../src/kanban/resource-catalog';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close();});
async function fixture(enabled = true, workTypes?: KanbanWorkType[]) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs), journal = new KanbanAutomationJournal(fs, kanbanJournalOptions);
    await journal.open();
    const actor = {kind: 'human' as const, id: 'admin'}, log = vi.fn();
    const service = createKanbanModule({store, actor, authorize: async () => {}, log});
    const folders = ['one', 'two', 'local'].map(id => ({name: id, path: '/' + id, project: {id, source: {kind: id === 'local' ? 'local' : 'remote'}}}));
    const projects = {list: async () => folders, get: async (id: string) => {
        const row = folders.find(row => row.project.id === id); if (!row) throw Object.assign(new Error('Missing'), {code: 'ENOENT'}); return row;
    }} as unknown as Pick<ProjectService, 'list' | 'get'>;
    await service.create({id: 'source', title: 'Development', ...(workTypes ? {workTypes, defaultWorkType: workTypes.find(type => type.executable)!.id} : {}), scope: {kind: 'system'}, members: [{...actor, responsibility: 'Manage', roles: ['coordinator', 'reviewer', 'worker']}, {kind: 'human', id: 'reviewer', responsibility: 'Review', roles: ['reviewer']}], policy: {requireEstimate: false, review: 'assignee'}});
    const reviewer = createKanbanModule({store, actor: {kind: 'human', id: 'reviewer'}, authorize: async () => {}, log});
    let sequence = 0;
    const command = async (command: KanbanCommand) => (command.type === 'review' ? reviewer : service).execute('source', {operationId: 'request-' + ++sequence, expectedRevision: (await service.read('source')).revision, command});
    await command({type: 'configure-automation', settings: {enabled, autoAccept: false,
        planner: {system: 'agent', id: 'planner', revision: '1'}, executor: {system: 'agent', id: 'worker', revision: '1'},
        coordinator: {kind: 'service', id: 'planner'}, worker: {kind: 'service', id: 'worker'}}});
    await command({type: 'append-record', record: {id: 'decision', kind: 'decision', title: 'Goal', content: 'PRIVATE_REQUIREMENT', rationale: 'Acceptance criteria', itemIds: [], sources: [],
        externalRefs: ['one', 'two'].map(id => ({system: 'nestos-remote-project', id}))}});
    const open = () => createRecordExecution({service, journal, resources: projectResourceCatalog(projects), log});
    return {service, command, open, projects, log, journal,fs};
}

async function completeCoordination(f:Awaited<ReturnType<typeof fixture>>,id:string):Promise<void>{
 const board=await f.service.read('source'),parent=board.items.find(item=>item.id===id)!,rank=(board.workTypes??(await import('@nestos/kanban/contracts')).DEFAULT_KANBAN_WORK_TYPES).find(type=>type.id===parent.planning?.kind)!.rank;
 const type=(board.workTypes??(await import('@nestos/kanban/contracts')).DEFAULT_KANBAN_WORK_TYPES).find(type=>type.executable&&type.rank>rank)!;
 const child=id+'-execute';await f.command({type:'create-item',item:{id:child,title:'Execute',responsibility:'Implement',acceptance:'Verified'},planning:{kind:type.id,parentId:id,priority:2,dependencies:[],references:[]}});
 await f.command({type:'finish-planning',itemId:id});await f.command({type:'set-stage',itemId:child,stage:'open'});
 const claimed=await f.command({type:'claim',itemId:child});await f.command({type:'submit',itemId:child,token:claimed.items.find(item=>item.id===child)!.owner!.token,resultRef:'verified'});
 await f.command({type:'review',itemId:child,accept:true});await f.command({type:'close-plan',itemId:id,resultRef:'children-verified'});
}

it('rejects unconfirmed/stale decisions and local project selection', async () => {
    const f = await fixture(), execution = f.open();
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'DECISION_NOT_CONFIRMED'});
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    await expect(execution.runRecord('source', {operationId: 'run', recordId: 'decision', expectedRevision: 1})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
    await expect(validateRemoteReferences(f.projects, {externalRefs: [{system: 'nestos-remote-project', id: 'local'}]})).rejects.toMatchObject({code: 'REMOTE_PROJECT_REQUIRED'});
    expect(await execution.recordResources()).toHaveLength(2);
});

it('deduplicates concurrent runs and preserves remote bindings across reopening', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2}, execution = f.open();
    const [first, second] = await Promise.all([execution.runRecord('source', request), execution.runRecord('source', {...request, operationId: 'double-click'})]);
    expect(first.id).toBe(second.id);
    const board = await f.service.read(first.boardId);
    expect(first.boardId).toBe('source'); expect(board.items).toHaveLength(2); expect(board.automation).toMatchObject({enabled: true, autoAccept: false});
    expect(board.items.filter(item => first.itemIds!.includes(item.id)).map(item => item.externalRefs![0].id)).toEqual(['one', 'two']);
    expect(board.items.filter(item => item.planning?.parentId === first.rootItemId)).toHaveLength(2);
    await f.open().scan(); expect(await f.open().runRecord('source', request)).toMatchObject({id: first.id, boardId: first.boardId});
    expect((await f.service.catalog()).filter(board => board.scope.kind === 'collection')).toHaveLength(0);
    expect((await f.service.record('source', 'decision')).status).toBe('confirmed');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REQUIREMENT');
    await expect(execution.runRecord('source', {...request, expectedRevision: 9})).rejects.toMatchObject({code: 'IDEMPOTENCY_CONFLICT'});
});

it('recovers a committed creation when the response is lost without creating duplicate items', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const original = f.service.execute.bind(f.service); let lost = false;
    vi.spyOn(f.service, 'execute').mockImplementation(async (id, request) => {
        const result = await original(id, request);
        if (request.command.type === 'create-item' && !lost) {lost = true; throw Object.assign(new Error('PRIVATE_REPLY'), {code: 'EIO'});}
        return result;
    });
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'EIO'});
    const run = await f.open().runRecord('source', request);
    expect((await f.service.read(run.boardId)).items).toHaveLength(2);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('PRIVATE_REPLY');
});

it('keeps one run after linking the decision advances its revision and does not duplicate a feature', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const first = await f.open().runRecord('source', {operationId: 'first', recordId: 'decision', expectedRevision: 2});
    const decision = await f.service.record('source', 'decision'); expect(decision.itemIds).toEqual(expect.arrayContaining(first.itemIds!));
    const request = {operationId: 'again', recordId: 'decision', expectedRevision: decision.revision};
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.open().runRecord('source', request)).id).toBe(first.id);
    expect((await f.service.read('source')).items).toHaveLength(2);
    await expect(f.open().runRecord('source', {...request, operationId: 'separate', placement: 'new-board'})).rejects.toMatchObject({code: 'DECISION_EXECUTION_PLACEMENT_CONFLICT'});
});
it('requires explicitly resuming paused AI and only creates a board when selected', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {operationId: 'run', recordId: 'decision', expectedRevision: 2};
    await expect(f.open().runRecord('source', request)).rejects.toMatchObject({code: 'AUTOMATION_PAUSED'});
    expect((await f.service.read('source')).items).toHaveLength(0);
    const run = await f.open().runRecord('source', {...request, placement: 'new-board'});
    expect(run.boardId).not.toBe('source'); expect((await f.service.catalog())).toHaveLength(2);
    expect((await f.service.read('source')).automation?.enabled).toBe(false);
    expect((await f.service.read(run.boardId)).automation?.enabled).toBe(true);
});
it('creates a single task for one project and derives completion only from its own work', async () => {
    const f = await fixture();
    await f.command({type: 'append-record', record: {id: 'small', kind: 'decision', title: 'Cloze modes', content: 'Implement', rationale: 'Verified', itemIds: [], sources: [], externalRefs: [{system: 'nestos-remote-project', id: 'one'}]}});
    await f.command({type: 'review-record', recordId: 'small', accept: true});
    await f.command({type: 'create-item', item: {id: 'unrelated', title: 'Other', responsibility: 'Other', acceptance: 'Other'}});
    await f.command({type: 'block-item', itemId: 'unrelated', reason: 'Independent work'});
    const run = await f.open().runRecord('source', {operationId: 'small', recordId: 'small', expectedRevision: 2});
    expect(run.itemIds).toHaveLength(1); expect(run.rootItemId).toBe(run.itemIds![0]); expect(run.state).toBe('running');
    expect((await f.service.item('source',run.rootItemId!)).item.taskType).toBe('coordination');
    await completeCoordination(f,run.rootItemId!);
    await f.open().scan();
    expect((await f.open().recordExecutions('source', 'small'))[0].state).toBe('completed');
    const completed=await f.service.record('source','small');
    await expect(f.open().runRecord('source',{operationId:'after-completed',recordId:'small',expectedRevision:completed.revision})).rejects.toMatchObject({code:'DECISION_EXECUTION_COMPLETED'});
    expect((await f.service.read('source')).items.find(item => item.id === 'unrelated')?.blocked).toBeDefined();
});
it('completes the decision after each project coordination task finishes its execution children',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const run=await f.open().runRecord('source',{operationId:'projects',recordId:'decision',expectedRevision:2});
 expect(run.rootItemId).toBeUndefined();expect(run.itemIds).toHaveLength(2);
 await completeCoordination(f,run.itemIds![0]);await f.open().scan();expect((await f.open().recordExecutions('source','decision'))[0].state).not.toBe('completed');
 await completeCoordination(f,run.itemIds![1]);await f.open().scan();expect((await f.open().recordExecutions('source','decision'))[0].state).toBe('completed');
 expect((await f.service.record('source','decision')).status).toBe('confirmed');
});

it('resumes legacy dedicated boards in place without introducing parent items or moving identities', async () => {
    const f = await fixture(false); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const record = await f.service.record('source', 'decision'), source = await f.service.read('source');
    const legacy = {id: 'legacy', sourceBoardId: 'source', recordId: 'decision', recordRevision: 2, boardId: 'run-legacy', state: 'preparing',
        createdAt: 1, updatedAt: 1, record, automation: source.automation};
    await f.journal.update('record-runs:source', () => [legacy]);
    await f.journal.update('record-operation:legacy-click', () => legacy);
    await f.open().scan();
    const run = await f.open().runRecord('source', {operationId: 'legacy-click', recordId: 'decision', expectedRevision: 2});
    expect(run.boardId).toBe('run-legacy'); expect(run.rootItemId).toBeUndefined();
    expect((await f.service.read(run.boardId)).items.map(item => item.id)).toEqual(['work-0', 'work-1']);
    expect((await f.service.read('source')).items).toHaveLength(0);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(2);
});
it('marks only the affected decision run failed when a task is cancelled', async () => {
    const f = await fixture(); await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'cancelled', recordId: 'decision', expectedRevision: 2});
    await f.command({type: 'cancel-item', itemId: run.itemIds![0], reason: 'User choice'}); await f.open().scan();
    expect((await f.open().recordExecutions('source', 'decision'))[0]).toMatchObject({state: 'failed', code: 'DECISION_TASK_CANCELLED'});
    expect((await f.service.item('source', run.itemIds![1])).item.status).toBe('backlog');
});

it('uses configured work type ranks instead of requiring feature/task identifiers', async () => {
    const f = await fixture(true, [{id: 'bundle', label: 'Delivery', rank: 5, executable: false}, {id: 'action', label: 'Work', rank: 9, executable: true}]);
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const run = await f.open().runRecord('source', {operationId: 'custom', recordId: 'decision', expectedRevision: 2, placement: 'new-board'});
    const board = await f.service.read(run.boardId);
    expect(run.rootItemId).toBeUndefined();
    expect(board.items.filter(item => run.itemIds!.includes(item.id)).every(item => item.planning?.kind === 'bundle' && item.taskType==='coordination')).toBe(true);
    await f.open().scan(); expect((await f.service.read(run.boardId)).items).toHaveLength(2);
});

it('provides a single resource selector that inherits and locks the parent project',async()=>{
    const f=await fixture(),reference={system:'nestos-remote-project',id:'one'};
    await f.command({type:'create-item',item:{id:'parent',title:'Parent',responsibility:'Work',acceptance:'Verified',externalRefs:[reference]}});
    expect(await f.open().itemResources('source','parent')).toMatchObject({selected:reference,required:true,readonly:true,resources:[
        {reference:{system:'nestos-remote-project',id:'one'}},{reference:{system:'nestos-remote-project',id:'two'}}]});
});
it('quiesces at a committed decision boundary and reopens with the same run and items', async () => {
    const f = await fixture(), first = f.open();
    await f.command({type: 'review-record', recordId: 'decision', accept: true});
    const request = {recordId: 'decision', operationId: 'safe-restart', expectedRevision: (await f.service.record('source', 'decision')).revision};
    const before = await first.runRecord('source', request);
    await first.quiesce(); await expect(first.runRecord('source', request)).rejects.toMatchObject({code: 'SERVICE_STOPPING'});
    const after = await f.open().runRecord('source', request);
    expect(after.id).toBe(before.id); expect(after.itemIds).toEqual(before.itemIds);
    expect((await f.service.read('source')).items.map(row => row.id)).toEqual(expect.arrayContaining(before.itemIds!));
    expect(after.updatedAt).toBe(before.updatedAt);
    const receipt = await f.journal.get<Record<string, unknown>>('record-operation:safe-restart');
    expect(receipt).toMatchObject({schema: 2, id: before.id, sourceBoardId: 'source'});
    expect(receipt).not.toHaveProperty('state'); expect(receipt).not.toHaveProperty('record');
});

it('cancels all decision descendants, resumes cancellation after restart and permits logical record deletion',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{operationId:'run',recordId:'decision',expectedRevision:2});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'cancel-decision',action:'cancel'});
    const board=await f.service.read('source');expect(board.items.every(item=>item.control?.action==='cancel')).toBe(true);
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    for(let pass=0;pass<3;pass++)await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[]}},f.journal),f.journal,await f.service.read('source'),f.service);
    await f.open().scan();
    expect((await f.service.read('source')).items.every(item=>item.status==='cancelled')).toBe(true);
    expect(await f.service.record('source','decision')).toMatchObject({status:'cancelled'});
    expect((await f.open().recordExecutions('source','decision')).find(row=>row.id===run.id)?.state).toBe('cancelled');
    await f.command({type:'delete-record',recordId:'decision'});
    expect((await f.service.records('source',{kind:'decision'})).items).toEqual([]);
    expect((await f.service.record('source','decision')).deletedAt).toBeTypeOf('number');
});
it('cancels a decision with no execution without materializing work or contacting project resources',async()=>{
    const f=await fixture();
    await f.open().controlRecord('source',{recordId:'decision',operationId:'cancel-draft',action:'cancel'});
    expect((await f.service.read('source')).items).toEqual([]);
    expect(await f.service.record('source','decision')).toMatchObject({status:'cancelled'});
});
it('projects unresolved planning clarification as a blocked decision and clears it only after the status changes',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});const execution=f.open();
    const run=await execution.runRecord('source',{operationId:'clarification-run',recordId:'decision',expectedRevision:2});
    const itemId=run.itemIds![0];
    await f.command({type:'report-analysis',itemId,operationId:'analysis',status:{itemId,state:'clarification',reason:'Please confirm the scope'}});
    await execution.scan();expect(await execution.recordExecutions('source','decision')).toContainEqual(expect.objectContaining({state:'blocked',code:'DECISION_INPUT_REQUIRED'}));
    expect(Object.values((await f.service.workflow('source')).dispatches)).toHaveLength(0);
    await f.command({type:'report-analysis',itemId,operationId:'clarified',status:{itemId,state:'ready',reason:'Confirmed'}});
    await execution.scan();const resumed=(await execution.recordExecutions('source','decision'))[0];expect(resumed.state).toBe('running');expect(resumed.code).toBeUndefined();
});

async function settleCancellation(f:Awaited<ReturnType<typeof fixture>>) {
    const {scanTaskControls}=await import('@nestos/kanban/integration');
    for(let pass=0;pass<3;pass++)await scanTaskControls(kanbanControlOptions({calls:{list:async()=>[]}},f.journal),f.journal,await f.service.read('source'),f.service);
    await f.open().scan();
}
it('archives generated tasks with the decision and deletes archived descendants on a later request',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    await f.command({type:'create-item',item:{id:'unrelated',title:'Unrelated',responsibility:'Keep',acceptance:'Keep'}});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'archive',action:'archive'});await settleCancellation(f);
    expect((await f.service.record('source','decision')).archivedAt).toBeTypeOf('number');
    expect((await f.service.records('source')).items).toHaveLength(0);
    expect((await f.service.query('source',{view:'archive'})).total).toBe(2);
    expect((await f.service.read('source')).items.map(item=>item.id)).toEqual(['unrelated']);
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});await f.open().scan();
    expect((await f.service.record('source','decision')).deletedAt).toBeTypeOf('number');
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});
    for(const id of run.itemIds!)expect((await f.service.item('source',id)).item.deletedAt).toBeTypeOf('number');
    expect((await f.service.item('source','unrelated')).item.deletedAt).toBeUndefined();
});
it('restarts a decision after settlement with a new run and retains replay identity across reopening',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const old=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    const request={recordId:'decision',operationId:'restart',action:'restart' as const};
    await f.open().controlRecord('source',request);await settleCancellation(f);
    const runs=await f.open().recordExecutions('source','decision');
    expect(runs).toHaveLength(2);expect(runs[0]).toMatchObject({id:old.id,state:'cancelled'});
    expect(runs[1].id).not.toBe(old.id);expect(runs[1].state).toBe('running');
    expect((await f.service.record('source','decision')).status).toBe('confirmed');
    await f.open().controlRecord('source',request);await f.open().scan();
    expect(await f.open().recordExecutions('source','decision')).toHaveLength(2);
    expect((await f.service.query('source',{view:'archive'})).total).toBe(2);
});
it('keeps decision deletion pending when task cancellation has no confirmed receipt',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    await f.open().controlRecord('source',{recordId:'decision',operationId:'delete',action:'delete'});
    for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'unknown',code:'CONNECTION_LOST'});
    await f.open().scan();
    const record=await f.service.record('source','decision');expect(record.status).toBe('cancelling');expect(record.deletedAt).toBeUndefined();
    expect((await f.service.read('source')).items.every(item=>item.deletedAt===undefined)).toBe(true);
});
it('keeps unclarified decision planning out of development lists and counts attention once per decision',async()=>{
    const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
    const run=await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
    expect((await f.service.query('source',{view:'all',excludePlanning:true})).total).toBe(0);
    for(const itemId of run.itemIds!)await f.command({type:'report-analysis',itemId,operationId:'clarify-'+itemId,status:{itemId,state:'clarification',reason:'Confirm scope'}});
    expect((await f.service.overview('source')).attention).toMatchObject({decision:1,board:0,log:0});
    expect((await f.service.records('source',{kind:'decision'})).items[0].attention).toBe('waiting-input');
    expect((await f.service.catalog())[0].attention?.decision).toBe(1);
});

it('recovers restart finalization after new run creation changed the live decision revision',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});await f.open().runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
 await f.open().controlRecord('source',{recordId:'decision',operationId:'restart-receipt',action:'restart'});await settleCancellation(f);
 const controls=await f.journal.find<any>('record-control:',row=>row.operationId==='restart-receipt');
 await f.journal.update(controls[0].key,old=>({...old as any,settled:false}));
 await f.open().scan();expect(await f.open().recordExecutions('source','decision')).toHaveLength(2);
 expect((await f.journal.get<any>(controls[0].key)).settled).toBe(true);
});

it('reports automatically created coordination work as blocked with its exact planning failure instead of running',async()=>{
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});const execution=f.open();
 const run=await execution.runRecord('source',{operationId:'auto',recordId:'decision',expectedRevision:2});
 expect(run.itemIds).toHaveLength(2);const root=run.itemIds![0],before=(await f.service.read('source')).items.length;
 await f.command({type:'report-analysis',itemId:root,operationId:'preparation',status:{itemId:root,state:'failed',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED'}});
 await execution.scan();expect((await execution.recordExecutions('source','decision'))[0]).toMatchObject({state:'blocked',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',stage:'planning'});
 expect((await f.service.records('source',{kind:'decision'})).items[0]).toMatchObject({attention:'error',attentionCode:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',attentionItemId:root});
 await execution.scan();expect((await f.service.read('source')).items).toHaveLength(before);
});
it('cancels from the decision protocol and keeps unknown execution receipts pending across recovery',async()=>{
 const {resolveDecisionRequest}=await import('../src/kanban/decision-conversation-requests'),{decisionConversationViews}=await import('../src/kanban/decision-conversation-views');
 const f=await fixture();await f.command({type:'review-record',recordId:'decision',accept:true});
 const runtime=f.open(),run=await runtime.runRecord('source',{recordId:'decision',operationId:'run',expectedRevision:2});
 await f.journal.update('decision-conversation-record:conversation',()=>({recordId:'decision',state:'confirmed',proposalDigest:'preview'}));
 const read=vi.fn(async()=>({messages:[{id:'cancel',role:'user',text:'取消决策'}]}));
 const options={...f,client:()=>({...f.service,...runtime}),remote:{projectConversation:async()=>({read,close:async()=>{}})}} as any;
 const conversation={id:'conversation',boardId:'source',sessionId:'original',resourceId:'/native/original',binding:{projectId:'one',profileId:'codex'}} as any;
 const request={id:'cancel',scopeId:'conversation',method:'decision.cancel',params:{}};
 expect(await resolveDecisionRequest(options,conversation,request)).toMatchObject({state:'cancelling',recordId:'decision',retainedSession:true});
 for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'unknown',code:'CONNECTION_LOST'});
 await runtime.quiesce();const recovered=f.open();options.client=()=>({...f.service,...recovered});await recovered.scan();
 expect(await resolveDecisionRequest(options,conversation,{...request,id:'inspect',method:'decision.read'})).toMatchObject({state:'cancelling',record:{status:'cancelling'}});
 expect((await decisionConversationViews(options,[{...conversation,state:'confirmed',createdAt:1,recordId:'decision'}]))[0].state).toBe('cancelling');
 for(const item of (await f.service.read('source')).items)await f.command({type:'control-receipt',itemId:item.id,controlId:item.control!.id,state:'cancelled'});
 await recovered.scan();expect(await resolveDecisionRequest(options,conversation,{...request,id:'settled',method:'decision.read'})).toMatchObject({state:'cancelled',record:{status:'cancelled'}});
 expect((await recovered.recordExecutions('source','decision')).find(row=>row.id===run.id)?.state).toBe('cancelled');
 expect((await f.service.read('source')).items).toHaveLength(2);expect((await f.service.read('source')).items.every(item=>item.status==='cancelled')).toBe(true);
});

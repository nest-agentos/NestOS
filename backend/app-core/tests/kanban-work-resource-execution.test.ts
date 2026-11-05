import {expect, it, vi} from 'vitest';
import {workResourceExecution} from '../src/presets/kanban-work-resource-execution';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {durableState, request} from './harness-execution-fixture';
import {context, operation} from './harness-context-fixture';

async function fixture(release = true) {
    const saved = durableState(), store = new HarnessContextBindings(saved.state, 'child');
    await store.claim('binding', context, {...request.connection, id: 'work-ready'}, operation);
    await store.attach('binding', operation.operationId, {nodeConnectionId: 'node', profileId: 'codex', workspaceId: 'workspace', epoch: 'epoch', sessionId: 'native'});
    if (release) {const staged = await store.prepareSettlement('binding', operation.operationId, {operationId: operation.operationId, kind: 'terminal', knownHeadRef: 'turn'});
    await store.release('binding', operation.operationId, staged.revision + 1);}
    const snapshot = {writerLock:{status:'not-held'},active: false, pending: undefined, requests: [], draft: '', controls: [], instructionQueue: {items: []},
        observation: {stale: false, connection: 'online', receiptUnknown: false, execution: 'idle'}};
    const view = {read: vi.fn(async () => {}), snapshot: () => snapshot, close: vi.fn(async () => {})};
    const call = {callerState: {settled: true}, executionTree: {settled: true}, receipt: {executionSessionId: 'child'}};
    const options = {journal: {get: vi.fn(async () => undefined)}, calls: {list: vi.fn(async () => [call])},
        kernel: {task:vi.fn(async()=>({id:'task-1',effects:{},exit:{status:'failed'}})),inspectSession: vi.fn(async () => ({getShared: saved.state.get}))}, remote: {projectConversation: vi.fn(async () => view)}} as never;
    return {options, snapshot, view, call};
}
it('requires native terminal evidence and uses a read-only view without acquiring a writer', async () => {
    const f = await fixture(); expect(await workResourceExecution(f.options, 'ready', 'project')).toEqual([]);
    expect((f.options as any).remote.projectConversation).toHaveBeenCalledWith('project', 'codex', 'native', undefined, true);
    expect(f.view.close).toHaveBeenCalledOnce(); f.snapshot.active = true;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    f.snapshot.active = false; f.snapshot.draft = 'Pending user input';
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    f.snapshot.draft = ''; f.snapshot.observation.stale = true;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_EXECUTION_UNKNOWN');
});
it('fails closed for missing calls or unsettled execution trees without opening a native conversation', async () => {
    const f = await fixture(); f.call.executionTree.settled = false;
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_IN_USE');
    expect((f.options as any).remote.projectConversation).not.toHaveBeenCalled();
    (f.options as any).calls.list.mockResolvedValue([]);
    expect(await workResourceExecution(f.options, 'ready', 'project')).toContain('WORKTREE_EXECUTION_UNKNOWN');
});

it('checks the real writer before cleaning a settled call whose context ownership was left behind', async () => {
    const f = await fixture(false);
    expect(await workResourceExecution(f.options,'ready','project')).toEqual([]);
    f.snapshot.writerLock.status = 'held';
    expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_IN_USE');
    f.snapshot.writerLock.status = 'unknown';
    expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_EXECUTION_UNKNOWN');
    f.snapshot.writerLock.status = 'not-held';
    (f.options as any).kernel.task.mockResolvedValue({id:'other-owner',effects:{},status:'running'});
    expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_IN_USE');
    f.call.executionTree.settled = false;
    expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_IN_USE');
});
it('permits an owned idle harness writer for continuation but keeps cleanup and active writers protected',async()=>{
    const f=await fixture();Object.assign(f.snapshot.observation,{owned:true});f.snapshot.writerLock.status='held';
    expect(await workResourceExecution(f.options,'ready','project',{purpose:'resume',operationId:'build'})).toEqual([]);
    expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_IN_USE');
    f.snapshot.active=true;expect(await workResourceExecution(f.options,'ready','project',{purpose:'resume'})).toContain('WORKTREE_IN_USE');
    f.snapshot.active=false;Object.assign(f.snapshot.observation,{owned:false});
    expect(await workResourceExecution(f.options,'ready','project',{purpose:'resume'})).toContain('WORKTREE_IN_USE');
});
it('excludes only the admitted operation itself from workspace occupation checks',async()=>{
    const f=await fixture(),get=(f.options as any).journal.get;
    get.mockImplementation(async(key:string)=>key==='review-operation-scopes'?[{board:'b',item:'i'}]:key.startsWith('review-operations:')?{jobs:['build']}:key==='review-operation:build'?{id:'build',phase:'prepared',snapshot:{context:{worktreeId:'ready'}}}:undefined);
    expect(await workResourceExecution(f.options,'ready','project',{purpose:'resume'})).toContain('WORKTREE_IN_USE');
    expect(await workResourceExecution(f.options,'ready','project',{purpose:'resume',operationId:'build'})).toEqual([]);
});

it('allows cleanup only after the native session is archived and all execution evidence is idle',async()=>{
 const f=await fixture();f.snapshot.writerLock.status='held';Object.assign(f.snapshot,{archived:true});
 expect(await workResourceExecution(f.options,'ready','project')).toEqual([]);
 f.snapshot.active=true;expect(await workResourceExecution(f.options,'ready','project')).toContain('WORKTREE_IN_USE');
});

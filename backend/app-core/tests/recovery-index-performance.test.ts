import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {Kernel} from '@nestos/durable-kernel';
import {IndependentCallService, FlowInvocationService} from '@nestos/llm-session';
import {FlowCommand} from '@nestos/llm-flow/contracts';
import {recoverFlowSchedulers} from '../src/runtime/flow-scheduler-recovery';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of releases.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    releases.push(() => manager.dispose());
    const kernel = new Kernel({catalog: {fs, rootPath: '/catalog'}});
    kernel.registerStorageResolver({kind: 'fixture', resolve: async () => ({fs, rootPath: '/s'})}); await kernel.initialize();
    releases.push(async () => {kernel.dispose(); await kernel.waitIdle();});
    await fs.meta.seq!.transaction!(async tx => {
        for (let i = 0; i < 2000; i++) await tx.setEntry('/catalog/catalog.seq', `session/history-${i}`, JSON.stringify({id: `history-${i}`, status: 'open'}));
    });
    return {kernel};
}

it('locates all three empty recovery scopes in three queries without reading historical Sessions or Tasks', async () => {
    const {kernel} = await fixture(), sessions = vi.spyOn(kernel, 'listSessions'), shared = vi.spyOn(kernel, 'listShared');
    const tasks = vi.spyOn(kernel, 'listSessionTasks'), bodies = vi.spyOn(kernel, 'task');
    const taskIndex = vi.spyOn(kernel, 'listRecoveryTasks'), sharedIndex = vi.spyOn(kernel, 'listRecoveryShared');
    const execute = vi.fn(), calls = new IndependentCallService({kernel, repository: {} as never, transfers: {} as never});
    releases.push(() => calls.dispose()); const started = performance.now();
    (await recoverFlowSchedulers(kernel, {execute} as never, async () => true))();
    await calls.recover(); await new FlowInvocationService(kernel, {} as never, {} as never).recover();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(taskIndex).toHaveBeenCalledTimes(2); expect(sharedIndex).toHaveBeenCalledOnce();
    for (const read of [sessions, shared, tasks, bodies, execute]) expect(read).not.toHaveBeenCalled();
});

it('reads one indexed root without enumerating unrelated history and resumes only that root', async () => {
    const {kernel} = await fixture(), session = await kernel.createSession({id: 'pending', storage: {kind: 'fixture', locator: null}});
    const root = await session.submit({program: {kind: 'flow.aggregate', version: '1'}, input: {awaitingSchedule: true},
        labels: {kind: 'flow-root'}, deferStart: true, recovery: {scope: 'flow.scheduler', until: 'terminal'}});
    const sessions = vi.spyOn(kernel, 'listSessions'), tasks = vi.spyOn(kernel, 'listSessionTasks'), read = vi.spyOn(kernel, 'task');
    const execute = vi.fn(async () => ({})), started = performance.now();
    (await recoverFlowSchedulers(kernel, {execute} as never, async () => true))();
    expect(performance.now() - started).toBeLessThan(5000);
    expect(read).toHaveBeenCalledExactlyOnceWith('pending', root.id);
    expect(sessions).not.toHaveBeenCalled(); expect(tasks).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledExactlyOnceWith(FlowCommand.RunResume, {sessionId: 'pending', taskId: root.id});
});

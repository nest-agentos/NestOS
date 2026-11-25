import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {Kernel} from '@nestos/durable-kernel';
import {dreamRoundProgram, dreamScheduleProgram} from '../src/dream/schedule-program';
import {dreamScheduleEffect} from '../src/dream/schedule-effect';

it('coalesces missed ticks and waits for the existing durable round before scheduling another', async () => {
    const input = {owner: 'owner', dream: 'dream', configRevision: 1, nextAt: 1000,
        schedule: {state: 'active' as const, firstAt: 1000, timeZone: 'UTC', cadence: {kind: 'interval' as const, milliseconds: 60_000},
            trigger: 'fixed' as const, maxConcurrency: 1}};
    const initial = await dreamScheduleProgram.init(input);
    const decision = await dreamScheduleProgram.reduce(initial.state, {type: 'timer-fired', id: 'dream-schedule', at: 1000, firedAt: 181_000});
    expect(decision.actions).toHaveLength(1); expect(decision.state.nextAt).toBe(241_000);
    const action = decision.actions![0]; if (action.type !== 'spawn') throw new Error('Expected round');
    expect(action.spawnKey).toBe('round:1000');
    const duplicate = await dreamScheduleProgram.reduce(decision.state, {type: 'timer-fired', id: 'dream-schedule', at: 241_000});
    expect(duplicate.actions).toBeUndefined();
    const child = await dreamScheduleProgram.reduce(decision.state, {type: 'task-exited', taskId: 'task', spawnKey: 'round:1000', exit: {status: 'succeeded'}} as never);
    expect(child.next).toEqual({type: 'wait', on: {type: 'timer', id: 'dream-schedule', at: 241_000}});
    const round = await dreamRoundProgram.init(action.spec.input as never);
    const effect = round.actions![0]; if (effect.type !== 'effect') throw new Error('Expected effect');
    expect(effect.effect.idempotencyKey).toBe((action.spec.input as {operationId: string}).operationId);
});

it('uses the real durable kernel to admit only one overdue round', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/'), kernel = new Kernel({catalog: {fs, rootPath: '/catalog'}, pollMs: 20});
    const runAll = vi.fn(async (_owner: string, _dream: string, _operation: string, configRevision: number) => ({configRevision, results: []}));
    kernel.registerStorageResolver({kind: 'dream-test', resolve: async () => ({fs, rootPath: '/sessions'})});
    kernel.registerProgram(dreamScheduleProgram); kernel.registerProgram(dreamRoundProgram); kernel.registerEffect(dreamScheduleEffect({runAll}, async () => {}, async () => {}));
    try {
        await kernel.initialize();
        const session = await kernel.createSession({id: 'schedule', storage: {kind: 'dream-test', locator: null}});
        const nextAt = Date.now() - 180_000;
        await session.submit({program: dreamScheduleProgram.manifest, requestId: 'schedule', input: {owner: 'owner', dream: 'dream', configRevision: 1,
            nextAt, schedule: {state: 'active', firstAt: nextAt, timeZone: 'UTC', cadence: {kind: 'interval', milliseconds: 60_000}, trigger: 'fixed', maxConcurrency: 1}}});
        await vi.waitFor(() => expect(runAll).toHaveBeenCalledOnce(), {timeout: 10000});
        const tasks = await kernel.listSessionTasks('schedule');
        expect(tasks.filter(task => task.program.kind === 'dream.scan-round')).toHaveLength(1);
        expect(runAll.mock.calls[0][2]).toMatch(/^schedule-/);
    } finally {kernel.dispose(); await kernel.waitIdle(); await manager.dispose();}
}, 20000);

it('reattaches the persisted schedule without spawning the completed round again', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const runAll = vi.fn(async (_owner: string, _dream: string, _operation: string, configRevision: number) => ({configRevision, results: []}));
    const make = async () => {
        const kernel = new Kernel({catalog: {fs, rootPath: '/catalog'}, pollMs: 20});
        kernel.registerStorageResolver({kind: 'dream-test', resolve: async () => ({fs, rootPath: '/sessions'})});
        kernel.registerProgram(dreamScheduleProgram); kernel.registerProgram(dreamRoundProgram); kernel.registerEffect(dreamScheduleEffect({runAll}, async () => {}, async () => {}));
        await kernel.initialize(); return kernel;
    };
    let kernel = await make();
    try {
        const session = await kernel.createSession({id: 'schedule', storage: {kind: 'dream-test', locator: null}});
        const nextAt = Date.now() - 120_000;
        await session.submit({program: dreamScheduleProgram.manifest, requestId: 'schedule', input: {owner: 'owner', dream: 'dream', configRevision: 1,
            nextAt, schedule: {state: 'active', firstAt: nextAt, timeZone: 'UTC', cadence: {kind: 'interval', milliseconds: 60_000}, trigger: 'fixed', maxConcurrency: 1}}});
        await vi.waitFor(async () => expect((await kernel.listSessionTasks('schedule')).some(task => task.program.kind === 'dream.scan-round' && task.status === 'succeeded')).toBe(true), {timeout: 10000});
        kernel.dispose(); await kernel.waitIdle(); kernel = await make();
        await kernel.recoverSession('schedule', {takeover: true});
        expect((await kernel.listSessionTasks('schedule')).filter(task => task.program.kind === 'dream.scan-round')).toHaveLength(1);
        expect(runAll).toHaveBeenCalledOnce();
    } finally {kernel.dispose(); await kernel.waitIdle(); await manager.dispose();}
}, 20000);

it('catches up at most once after the host was offline for several intervals', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    const now = Date.now(), {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const runAll = vi.fn(async (_owner: string, _dream: string, _operation: string, configRevision: number) => ({configRevision, results: []}));
    const make = async () => {
        const kernel = new Kernel({catalog: {fs, rootPath: '/catalog'}, pollMs: 20});
        kernel.registerStorageResolver({kind: 'dream-test', resolve: async () => ({fs, rootPath: '/sessions'})});
        kernel.registerProgram(dreamScheduleProgram); kernel.registerProgram(dreamRoundProgram); kernel.registerEffect(dreamScheduleEffect({runAll}, async () => {}, async () => {}));
        await kernel.initialize(); return kernel;
    };
    let kernel = await make();
    try {
        const session = await kernel.createSession({id: 'schedule', storage: {kind: 'dream-test', locator: null}});
        const firstAt = now + 60_000;
        const task = await session.submit({program: dreamScheduleProgram.manifest, requestId: 'schedule', input: {owner: 'owner', dream: 'dream', configRevision: 1,
            nextAt: firstAt, schedule: {state: 'active', firstAt, timeZone: 'UTC', cadence: {kind: 'interval', milliseconds: 60_000}, trigger: 'fixed', maxConcurrency: 1}}});
        await vi.waitFor(async () => expect((await task.status()).task.status).toBe('waiting'), {timeout: 10000});
        kernel.dispose(); await kernel.waitIdle(); vi.setSystemTime(now + 240_000);
        kernel = await make(); await kernel.recoverSession('schedule', {takeover: true});
        await vi.waitFor(() => expect(runAll).toHaveBeenCalledOnce(), {timeout: 10000});
        const tasks = await kernel.listSessionTasks('schedule');
        expect(tasks.filter(item => item.program.kind === 'dream.scan-round')).toHaveLength(1);
    } finally {kernel.dispose(); await kernel.waitIdle(); await manager.dispose(); vi.useRealTimers();}
}, 20000);

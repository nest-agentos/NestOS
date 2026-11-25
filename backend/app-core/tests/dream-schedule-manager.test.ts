import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {Kernel, KernelError, KernelErrorCode} from '@nestos/durable-kernel';
import {sessionDirectoryStorage, type SessionRepository} from '@nestos/llm-session';
import {DreamConfigStore} from '../src/dream/config-store';
import {DreamScheduleManager} from '../src/dream/schedule-manager';
import {dreamRoundProgram, dreamScheduleProgram} from '../src/dream/schedule-program';
import {dreamScheduleEffect} from '../src/dream/schedule-effect';

it('persists schedule admission, cancels the old task on pause, and resumes without replaying the old round', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const kernel = new Kernel({catalog: {fs, rootPath: '/catalog'}, pollMs: 20}), configs = new DreamConfigStore(fs);
    const runAll = vi.fn(async (_owner: string, _dream: string, _op: string, configRevision: number) => ({configRevision, results: []}));
    kernel.registerStorageResolver({kind: 'session-directory', resolve: async () => ({fs, rootPath: '/sessions'})});
    kernel.registerProgram(dreamScheduleProgram); kernel.registerProgram(dreamRoundProgram);
    kernel.registerEffect(dreamScheduleEffect({runAll}, configs.markSchedule.bind(configs), async () => {}));
    await kernel.initialize();
    const schedule = new DreamScheduleManager({fs, kernel, repository: {ensureSession: async () => {}} as unknown as SessionRepository,
        authorizeOwner: async () => {}, recover: async () => true, prepare: async id => {
            try {await kernel.openSession(id, sessionDirectoryStorage(id));}
            catch (error) {if (!(error instanceof KernelError) || error.code !== KernelErrorCode.SESSION_NOT_FOUND) throw error;
                await kernel.createSession({id, storage: sessionDirectoryStorage(id)});}
        }});
    const allow = {owner: async () => {}, source: async () => {}};
    const config = {name: 'Dream', enabled: true, files: [], schedule: {state: 'active' as const, firstAt: Date.now() + 100,
        timeZone: 'UTC', cadence: {kind: 'interval' as const, milliseconds: 60_000}, trigger: 'fixed' as const, maxConcurrency: 1}};
    try {
        await configs.save('owner', 'dream', 'create', null, config, allow);
        await schedule.reconcile('owner', 'dream');
        await vi.waitFor(() => expect(runAll).toHaveBeenCalledOnce(), {timeout: 10000});
        await configs.save('owner', 'dream', 'pause', 1, {...config, enabled: false}, allow);
        await schedule.reconcile('owner', 'dream');
        await configs.save('owner', 'dream', 'resume', 2, config, allow);
        await schedule.reconcile('owner', 'dream');
        await schedule.reconcile('owner', 'dream');
        expect(runAll).toHaveBeenCalledOnce();
    } finally {await schedule.quiesce(); kernel.dispose(); await kernel.waitIdle(); await manager.dispose();}
}, 20000);

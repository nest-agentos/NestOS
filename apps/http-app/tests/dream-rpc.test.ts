import {expect, it, vi} from 'vitest';
import {createApplicationRuntime} from '@nestos/app-core';
import {openApplicationView} from '@nestos/app-core/host';
import {MemoryBackend} from '@nestos/vfs-core';
import {RpcPeer, installViewProjections} from '@nestos/app-transport/application';

it('exposes only authorized Dream configuration commands through RPC', async () => {
    const provider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote open');}};
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'web', startupMode: 'interactive',
        digitalTwinAutoStart: false, remoteSourceProvider: provider});
    const view = await openApplicationView(runtime), report = vi.fn();
    let server!: RpcPeer;
    const client = new RpcPeer('client', call => server.handle(call), report, installViewProjections);
    server = new RpcPeer('server', async call => {client.applyUpdates(await server.refresh()); return client.handle(call);}, report);
    try {
        const project = await runtime.projects.create('Owner');
        const boot = await server.bootstrap({services: view.services, backend: view.backend}); client.applyUpdates(boot.updates);
        const dream = client.decode(boot.value!).services.dream;
        expect(await dream.create(project.project.id, 'dream', 'create', 'Dream')).toMatchObject({revision: 1});
        expect(await dream.list(project.project.id)).toMatchObject({items: [{id: 'dream', name: 'Dream'}], scanned: 1, truncated: false});
        expect(await dream.readConfig(project.project.id, 'dream')).toMatchObject({config: {name: 'Dream', files: []}});
        expect(await dream.openView(project.project.id, 'dream')).toMatchObject({config: {revision: 1}, history: {items: []}});
        expect(await dream.readRun(project.project.id, 'dream', 'unknown')).toBeNull();
        expect(await dream.history(project.project.id, 'dream')).toEqual({items: [], scanned: 0});
        const schedule = {state: 'active', firstAt: Date.now() + 60000, timeZone: 'UTC',
            cadence: {kind: 'interval', milliseconds: 60000}, trigger: 'fixed', maxConcurrency: 1};
        expect(await dream.configureSchedule(project.project.id, 'dream', 'schedule', 1, schedule)).toMatchObject({config: {revision: 2}, activation: 'ready'});
        expect((await dream.openView(project.project.id, 'dream')).scheduleStatus).toMatchObject({state: 'scheduled'});
        expect(await dream.configureSchedule(project.project.id, 'dream', 'pause-schedule', 2, {...schedule, state: 'paused'}))
            .toMatchObject({config: {revision: 3}, activation: 'ready'});
        await expect(dream.configureAdoptionSources(project.project.id, 'dream', 'invalid-source', 3,
            [{id: 'source', boardId: 'missing', itemId: 'item'}])).rejects.toThrow();
        await expect(dream.configureDecisionSources(project.project.id, 'dream', 'invalid-decision', 3,
            [{id: 'source', projectId: project.project.id, connectionId: 'dream-local', boardId: 'missing', recordId: 'decision', scannerSourceId: 'missing'}])).rejects.toThrow();
        await expect(dream.configureTaskSources(project.project.id, 'dream', 'invalid-task', 3,
            [{id: 'source', projectId: project.project.id, connectionId: 'dream-local', boardId: 'missing', itemId: 'task', scannerSourceId: 'missing'}])).rejects.toThrow();
        await expect(dream.configureSessionSources(project.project.id, 'dream', 'invalid-session', 3,
            [{id: 'source', projectId: project.project.id, connectionId: 'dream-local', sessionId: 'missing', maxRounds: 2, scannerSourceId: 'missing'}])).rejects.toThrow();
        await expect(dream.configureChangeSources(project.project.id, 'dream', 'invalid-change', 3,
            [{id: 'source', projectId: project.project.id, connectionId: 'dream-local', directory: '/docs', exclude: [], maxEntries: 10, scannerSourceId: 'missing'}])).rejects.toThrow('DREAM_CONFIG_INVALID');
        await expect(dream.remoteSessionProfiles(project.project.id, project.project.id, 'dream-local')).rejects.toThrow();
        await expect(dream.kanbanSourceCandidates(project.project.id, project.project.id, 'dream-local', 'missing', 'task')).rejects.toThrow();
        expect((await dream.readConfig(project.project.id, 'dream')).revision).toBe(3);
        expect(dream.evidence).toBeUndefined();
        await expect(dream.readConfig('missing', 'dream')).rejects.toThrow();
        expect(report).not.toHaveBeenCalled();
    } finally {await client.close(); await server.close(); await view.close(); await runtime.dispose();}
}, 60000);

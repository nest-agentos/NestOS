import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import {sha256HexSync} from '@nestos/common';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {NestosTwinSourceReader} from '../src/digital-twin/source-reader';
import {dreamProjectFilePort} from '../src/dream/project-file-source';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {runDreamTwinFileScan} from '../src/dream/twin-scan';
import {DreamConfigStore} from '../src/dream/config-store';
import {runConfiguredDreamFile} from '../src/dream/configured-scan';
import {openDreamSystemWorkspace} from '../src/dream/workspace';
import {DreamExecutionRegistry} from '../src/dream/execution-registry';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {readAdoptionSource, adoptionSourcePort, adoptionTwinScanPort} from '../src/dream/adoption-source';

it('uses the durable scanner receipt and resumes a failed settlement without repeating execution', async () => {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    const workspaceId = 'dream-' + sha256HexSync(JSON.stringify(['dream-source', 'dream']));
    const closeBackend = backend.close.bind(backend); backend.close = async () => {};
    const {manager} = await createVFS({rootBackend: backend}), system = await manager.openFileSystem('/');
    await new DreamConfigStore(system).save('dream-source', 'dream', 'seed', null, {name: 'Dream', enabled: false, files: []},
        {owner: async () => {}, source: async () => {}});
    const workspace = await openDreamSystemWorkspace(system, 'dream-source', 'dream', async () => {});
    const journal = new KanbanAutomationJournal(system); await journal.open();
    const outputs = await journal.artifact('dispatch', {content: 'TypeScript is used.'});
    const largeSession = 'TypeScript is used. '.repeat(11000);
    let allowed = true;
    const readManagedArtifact = async (target: string) => {
        if (target === 'large-session') return {text: largeSession, hash: sha256HexSync(largeSession), nativeIdentity: 'large-session-v1'};
        if (target !== 'configured-source') throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
        const result = await readAdoptionSource('adoption', null, 1, async () => {
            if (!allowed) throw new Error('revoked');
            return {dispatchId: 'dispatch', sessionId: 'execution-session', outputs};
        }, journal);
        const text = result.items[0];
        return {text, hash: sha256HexSync(text), nativeIdentity: result.version};
    };
    const openRuntime = () => createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false,
        digitalTwinWorkspaces: [{twinId: workspaceId, ownerId: 'dream-source', fs: workspace.fs, authorize: async () => {}, readManagedArtifact}]});
    let runtime = await openRuntime();
    try {
        const project = await runtime.projects.create('Dream source'), id = project.project.id, opened = await runtime.projects.openFiles(project.path);
        await opened.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'});
        await opened.dispose();
        let twin = await runtime.digitalTwin!.openWorkspace(workspaceId);
        expect(id).toBe('dream-source');
        await twin.configure({connectionId: 'default'}, (await twin.getSettings()).revision);
        const flow: FlowDraft = {id: 'dream-scan' as never, name: 'Dream scan', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]}}}],
            edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
        const target = (await twin.scannerTargets()).find(item => item.target.id === flow.id)!.target;
        const managed = await twin.ensureBoundScanner({sourceId: 'managed-source', planId: 'managed-plan',
            spec: {kind: 'managed-artifact', target: 'configured-source', label: ''}, executor: {target}, name: 'Managed',
            kinds: ['fact'], maxOutputTokens: 256, runTokenLimit: 1000});
        const managedAuthority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: id};
        const managedSource = {id: 'configured-source', projectId: id, connectionId: 'kanban-adoption', cursor: null};
        const managedPort = adoptionTwinScanPort(managedSource.id, adoptionSourcePort(managedSource, 'adoption', async () => {
            if (!allowed) throw new Error('revoked'); return managedAuthority;
        }, async () => {if (!allowed) throw new Error('revoked'); return {dispatchId: 'dispatch', sessionId: 'execution-session', outputs};}, journal));
        const managedStore = new DreamEvidenceStore(system), realManagedSettle = managedStore.settle.bind(managedStore);
        let failManaged = true;
        managedStore.settle = async (...args) => {if (failManaged) {failManaged = false; throw new Error('write failed');} return realManagedSettle(...args);};
        const managedInput = {ownerProjectId: id, dreamId: 'dream', operationId: 'managed-operation', planId: managed.planId,
            planRevision: managed.planRevision, twinSourceId: managed.sourceId, target: 'configured-source', sourceKind: 'managed-artifact' as const, source: managedSource};
        await expect(runDreamTwinFileScan(managedInput, twin, managedPort, managedStore, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_SETTLEMENT_FAILED');
        expect(await managedStore.watermark(id, 'dream', managedSource.id)).toBeNull();
        const capturedSource: [string, string, string] = [id, 'other', managedSource.id];
        const captured = await managedStore.readCapturedEvidence(id, 'dream', capturedSource, 1, () => managedPort.authorize(managedSource));
        expect(captured?.snapshot).toContain('TypeScript is used.');
        expect(await managedStore.readCapturedOperation(id, 'dream', managedInput.operationId, () => managedPort.authorize(managedSource))).toEqual(captured);
        const managedRun = (await twin.snapshot()).scans.runs.find(run => run.data.planId === managed.planId)!.id;
        allowed = false;
        await expect(managedStore.readCapturedEvidence(id, 'dream', capturedSource, 1, () => managedPort.authorize(managedSource))).rejects.toThrow();
        await expect(runDreamTwinFileScan(managedInput, twin, managedPort, managedStore, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_SOURCE_AUTHORIZATION_FAILED');
        expect(await managedStore.run(id, 'dream', managedInput.operationId)).toBeNull();
        allowed = true;
        await runDreamTwinFileScan(managedInput, twin, managedPort, managedStore, runtime.kernel.kernel, async () => {});
        const managedReceipt = await managedStore.run(id, 'dream', managedInput.operationId);
        expect(managedReceipt?.execution?.taskId).toBeTruthy();
        expect((await managedStore.watermark(id, 'dream', managedSource.id))?.cursor).toBeTruthy();
        await runDreamTwinFileScan(managedInput, twin, managedPort, managedStore, runtime.kernel.kernel, async () => {});
        expect((await managedStore.run(id, 'dream', managedInput.operationId))?.execution).toEqual(managedReceipt?.execution);
        expect((await twin.snapshot()).scans.runs.filter(run => run.data.planId === managed.planId)).toHaveLength(1);
        const managedEvidence = await twin.dreamScanEvidence('managed-event', managed.planId, managed.sourceId, managedRun);
        const managedJob = managedEvidence.jobs.find(job => job.data.scanScope?.runId === managedRun)!;
        expect(managedJob.data.state).toBe('committed');
        expect((await runtime.kernel.kernel.task(managedJob.data.sessionId, managedJob.data.taskId!)).exit?.status).toBe('succeeded');
        allowed = false;
        await expect(readManagedArtifact('configured-source')).rejects.toThrow('DREAM_SOURCE_UNAVAILABLE');
        allowed = true;
        const fileTarget = `project://${id}/notes/source.md`;
        const planId = await twin.saveScanRule(null, null, {name: 'Dream scanner', include: [], exclude: [], intervalMinutes: 30,
            trigger: 'event', enabled: true, input: {kind: 'file', path: fileTarget}, executor: {target}, kinds: ['fact'], maxOutputTokens: 256, runTokenLimit: 1000});
        const snapshot = await twin.snapshot(), plan = snapshot.scans.plans.find(item => item.id === planId)!;
        const file = {id: 'source', projectId: id, connectionId: 'connection', capability: 'fileRead' as const, path: '/notes/source.md'};
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: id};
        let fs = await runtime.vfs.openFileSystem('/');
        let reader = new NestosTwinSourceReader(fs, runtime.sessionRepository, runtime.projects);
        let revoke = false, checks = 0;
        const authorization = {authorizeDreamSource: async () => {
            if (++checks >= 4 && revoke) throw new Error('revoked');
            return authority;
        }} as never;
        let port = dreamProjectFilePort(authorization, file, reader);
        let store = new DreamEvidenceStore(fs); const realSettle = store.settle.bind(store); let fail = true;
        store.settle = async (...args) => {if (fail) {fail = false; throw new Error('injected settlement failure');} return realSettle(...args);};
        const input = {ownerProjectId: id, dreamId: 'dream', operationId: 'operation', planId, planRevision: plan.revision,
            twinSourceId: plan.data.sourceIds[0], target: fileTarget, source: {id: file.id, projectId: id, connectionId: file.connectionId, cursor: null}};
        await expect(runDreamTwinFileScan({...input, operationId: 'wrong-workspace'}, runtime.digitalTwin!, port, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_SCAN_PLAN_CHANGED');
        await expect(runDreamTwinFileScan(input, twin, port, store, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_SETTLEMENT_FAILED');
        expect(await store.run(id, 'dream', 'operation')).toBeNull();
        const priorJob = (await twin.snapshot()).jobs.find(job => job.data.scanScope?.planId === planId)!;
        await runtime.dispose(); runtime = await openRuntime();
        twin = await runtime.digitalTwin!.openWorkspace(workspaceId); fs = await runtime.vfs.openFileSystem('/');
        reader = new NestosTwinSourceReader(fs, runtime.sessionRepository, runtime.projects);
        port = dreamProjectFilePort(authorization, file, reader); store = new DreamEvidenceStore(fs);
        await expect(runDreamTwinFileScan({...input, target: 'project://other/file.md'}, twin, port, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
        await expect(runDreamTwinFileScan({...input, planRevision: 'different'}, twin, port, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_OPERATION_CONFLICT');
        let ownerChecks = 0;
        await expect(runDreamTwinFileScan(input, twin, port, store, runtime.kernel.kernel, async () => {
            if (++ownerChecks === 3) throw new Error('owner revoked');
        })).rejects.toThrow('DREAM_OWNER_AUTHORIZATION_FAILED');
        expect(await store.run(id, 'dream', 'operation')).toBeNull();
        revoke = true; checks = 0;
        await expect(runDreamTwinFileScan(input, twin, port, store, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        expect(await store.run(id, 'dream', 'operation')).toBeNull();
        revoke = false; checks = 0;
        const changed = await runtime.projects.openFiles(project.path);
        await changed.fs.driver.writeContent('/notes/source.md', 'The original source has changed.');
        await changed.dispose();
        await runDreamTwinFileScan(input, twin, port, store, runtime.kernel.kernel, async () => {});
        const record = await store.run(id, 'dream', 'operation');
        expect(record?.execution?.taskId).toBeTruthy(); expect(record?.findings).toHaveLength(1);
        expect(record?.execution?.taskId).toBe(priorJob.data.taskId);
        expect((await store.finding(id, 'dream', record!.findings![0]))?.quote).toBe('TypeScript is used.');
        const restore = await runtime.projects.openFiles(project.path);
        await restore.fs.driver.writeContent('/notes/source.md', 'TypeScript is used.');
        await restore.dispose();
        let triggered = 0;
        const failingTwin = {dreamScanEvidence: twin.dreamScanEvidence.bind(twin), waitScanRun: twin.waitScanRun.bind(twin),
            triggerScanPlan: async () => {triggered++; throw new Error('injected queue failure');}};
        const interrupted = {...input, operationId: 'interrupted-before-queue'};
        await expect(runDreamTwinFileScan(interrupted, failingTwin, port, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_EXECUTION_FAILED');
        const editedAgain = await runtime.projects.openFiles(project.path);
        await editedAgain.fs.driver.writeContent('/notes/source.md', 'Changed before a run was created.');
        await editedAgain.dispose();
        await expect(runDreamTwinFileScan(interrupted, failingTwin, port, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_CAPTURED_EXECUTION_UNAVAILABLE');
        expect(triggered).toBe(1);
        const restoreAgain = await runtime.projects.openFiles(project.path);
        await restoreAgain.fs.driver.writeContent('/notes/source.md', 'TypeScript is used.');
        await restoreAgain.dispose();
        const runCount = (await twin.snapshot()).scans.runs.filter(run => run.data.planId === planId).length;
        await runDreamTwinFileScan(input, twin, port, store, runtime.kernel.kernel, async () => {});
        expect((await twin.snapshot()).scans.runs.filter(run => run.data.planId === planId)).toHaveLength(runCount);
        const configs = new DreamConfigStore(fs);
        await configs.save(id, 'dream', 'configure', 1, {name: 'Dream', enabled: true,
            files: [{...file, planId, planRevision: plan.revision, twinSourceId: plan.data.sourceIds[0]}]}, {owner: async () => {}, source: async () => {}});
        const configured = {ownerProjectId: id, dreamId: 'dream', sourceId: file.id, operationId: 'unchanged'};
        const deps = {configs, evidence: store, registry: new DreamExecutionRegistry(fs), twin, kernel: runtime.kernel.kernel, reader,
            remote: {authorizeDreamSource: async () => authority} as never, authorizeOwner: async () => {}};
        await runConfiguredDreamFile(configured, deps);
        await runConfiguredDreamFile(configured, deps);
        expect((await store.run(id, 'dream', 'unchanged'))?.execution).toBeUndefined();
        expect((await twin.snapshot()).scans.runs.filter(run => run.data.planId === planId)).toHaveLength(runCount);
        const nextDirectory = await runtime.projects.openFiles(project.path);
        await nextDirectory.fs.driver.createFile({parentPath: '/notes', name: 'configured.md', content: 'TypeScript is used.'});
        await nextDirectory.dispose();
        const nextTarget = `project://${id}/notes/configured.md`;
        const nextPlanId = await twin.saveScanRule(null, null, {name: 'Configured scanner', include: [], exclude: [], intervalMinutes: 30,
            trigger: 'event', enabled: true, input: {kind: 'file', path: nextTarget}, executor: {target}, kinds: ['fact'], maxOutputTokens: 256, runTokenLimit: 1000});
        const nextPlan = (await twin.snapshot()).scans.plans.find(item => item.id === nextPlanId)!;
        await configs.save(id, 'dream', 'configure-next', 2, {name: 'Dream', enabled: true, files: [
            {...file, planId, planRevision: plan.revision, twinSourceId: plan.data.sourceIds[0]},
            {...file, id: 'next', path: '/notes/configured.md', planId: nextPlanId, planRevision: nextPlan.revision, twinSourceId: nextPlan.data.sourceIds[0]},
        ]}, {owner: async () => {}, source: async () => {}});
        await runConfiguredDreamFile({...configured, sourceId: 'next', operationId: 'configured-run'}, deps);
        const configuredResult = await store.run(id, 'dream', 'configured-run');
        expect(configuredResult?.execution?.taskId).toBeTruthy();
        expect(configuredResult?.configRevision).toBe(3);
        expect(await deps.registry.findRun(configuredResult!.execution!.scanRunId)).toMatchObject({ownerProjectId: id, dreamId: 'dream', sourceId: 'next', configRevision: 3});
        expect(configuredResult?.findings).toHaveLength(1);
        const invalidFlow: FlowDraft = {...flow, id: 'dream-invalid' as never, name: 'Invalid result',
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Unfounded', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'not in file'}]}}}]};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [invalidFlow]});
        const invalidTarget = (await twin.scannerTargets()).find(item => item.target.id === invalidFlow.id)!.target;
        const destination = await runtime.projects.openFiles(project.path);
        await destination.fs.driver.createFile({parentPath: '/notes', name: 'second.md', content: 'Other content.'});
        await destination.dispose();
        const badTarget = `project://${id}/notes/second.md`;
        const badPlanId = await twin.saveScanRule(null, null, {name: 'Invalid scanner', include: [], exclude: [], intervalMinutes: 30,
            trigger: 'event', enabled: true, input: {kind: 'file', path: badTarget}, executor: {target: invalidTarget}, kinds: ['fact'], maxOutputTokens: 256, runTokenLimit: 1000});
        const badPlan = (await twin.snapshot()).scans.plans.find(item => item.id === badPlanId)!;
        const badFile = {...file, id: 'second', path: '/notes/second.md'};
        const badPort = dreamProjectFilePort({authorizeDreamSource: async () => authority} as never, badFile, reader);
        const badInput = {...input, operationId: 'failed-operation', planId: badPlanId, planRevision: badPlan.revision,
            twinSourceId: badPlan.data.sourceIds[0], target: badTarget, source: {...input.source, id: badFile.id}};
        await expect(runDreamTwinFileScan(badInput, twin, badPort, store, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_EXECUTION_FAILED');
        expect(await store.run(id, 'dream', 'failed-operation')).toBeNull();
        await expect(runDreamTwinFileScan(badInput, twin, badPort, store, runtime.kernel.kernel, async () => {})).rejects.toThrow('DREAM_EXECUTION_FAILED');
        expect((await twin.snapshot()).scans.runs.filter(run => run.data.planId === badPlanId)).toHaveLength(1);
        await expect(runDreamTwinFileScan({...badInput, operationId: 'failed-retry'}, twin, badPort, store, runtime.kernel.kernel, async () => {}))
            .rejects.toThrow('DREAM_EXECUTION_FAILED');
        expect((await twin.snapshot()).scans.runs.filter(run => run.data.planId === badPlanId)).toHaveLength(2);
        await twin.configure({budgetUnlimited: true}, (await twin.getSettings()).revision);
        const largePlan = await twin.ensureBoundScanner({sourceId: 'large-source', planId: 'large-plan',
            spec: {kind: 'managed-artifact', target: 'large-session', label: ''}, executor: {target}, name: 'Large session',
            kinds: ['fact'], maxOutputTokens: 256, runTokenLimit: 1000000});
        const largeVersion = JSON.stringify(['large-session-v1', sha256HexSync(largeSession)]);
        const largeSource = {id: 'large-session', projectId: id, connectionId: 'connection', cursor: null};
        const largePort = {target: () => 'large-session', authorize: async () => authority,
            read: async () => ({items: [largeSession], cursor: largeVersion, version: largeVersion, scanned: 1})};
        await runDreamTwinFileScan({ownerProjectId: id, dreamId: 'dream', operationId: 'large-session-run',
            planId: largePlan.planId, planRevision: largePlan.planRevision, twinSourceId: largePlan.sourceId,
            target: 'large-session', sourceKind: 'managed-artifact', evidenceSourceType: 'session', source: largeSource},
        twin, largePort, store, runtime.kernel.kernel, async () => {});
        const largeRun = await store.run(id, 'dream', 'large-session-run');
        expect(largeRun?.execution?.additionalTasks?.length).toBeGreaterThan(0);
        expect(largeRun?.findings).toHaveLength(1);
    } finally {await runtime.dispose(); await journal.drain(); await workspace.dispose(); await manager.dispose(); await closeBackend();}
}, 60000);

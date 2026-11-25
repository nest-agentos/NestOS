import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import type {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {RoundLog} from '@nestos/llm-session';
import {adoptionScannerIds} from '../src/dream/adoption-source';

it('routes a Dream scanner through the host and restores its bound session after restart', async () => {
    const backend = new MemoryBackend(); await backend.init();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    const closeBackend = backend.close.bind(backend); backend.close = async () => {};
    const remoteProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    const openRuntime = () => createApplicationRuntime({backend, ownerKind: 'cli', digitalTwinAutoStart: false, remoteSourceProvider: remoteProvider});
    let runtime = await openRuntime();
    try {
        const owner = await runtime.projects.create('Owner'), source = await runtime.projects.create('Source'), secondSource = await runtime.projects.create('Second');
        const files = await runtime.projects.openFiles(source.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'}); await files.dispose();
        const secondFiles = await runtime.projects.openFiles(secondSource.path);
        await secondFiles.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'}); await secondFiles.dispose();
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'remote'};
        const stubRemote = () => vi.spyOn(runtime.projects.remoteMounts as unknown as ProjectRemoteMountService, 'authorizeDreamSource').mockResolvedValue(authority);
        const grant = stubRemote();
        const dream = runtime.dream!, ownerId = owner.project.id;
        await dream.create(ownerId, 'dream', 'seed', 'Dream');
        await dream.setModelConnection(ownerId, 'dream', 'default');
        const flow: FlowDraft = {id: 'dream-host-flow' as never, name: 'Dream host flow', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}],
                    dreamFindings: [{content: 'May prefer typed code', kind: 'inference', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'},
                        {content: 'Review type checks', kind: 'suggestion', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]}}}],
            edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
        const target = (await dream.scannerTargets(ownerId, 'dream')).find(item => item.target.id === flow.id)!.target;
        const personal = await runtime.projects.personal();
        const localFiles = await runtime.projects.openFiles(personal.path);
        await localFiles.fs.driver.createFile({parentPath: '/notes', name: 'local.md', recursive: true, content: 'TypeScript is used.'});
        await localFiles.dispose();
        await dream.create(ownerId, 'local-dream', 'create-local', 'Local Dream');
        await dream.setModelConnection(ownerId, 'local-dream', 'default');
        const local = await dream.addFile(ownerId, 'local-dream', 'add-local', 1, {projectId: personal.project.id,
            connectionId: 'dream-local', path: '/notes/local.md', executor: {target}, maxOutputTokens: 256, runTokenLimit: 1000});
        await dream.run({ownerProjectId: ownerId, dreamId: 'local-dream', sourceId: local.sourceId, operationId: 'local-run'});
        const localReceipt = await dream.evidence.run(ownerId, 'local-dream', 'local-run');
        expect(localReceipt?.execution?.taskId).toBeTruthy();
        expect(grant).not.toHaveBeenCalled();
        expect((await dream.readRun(ownerId, 'local-dream', 'local-run'))!.findings).toHaveLength(3);
        const access = runtime.projects.workspaceAccess.bind(runtime.projects);
        const revokeLocal = vi.spyOn(runtime.projects, 'workspaceAccess').mockImplementation(project =>
            project.project.id === personal.project.id ? 'ro' : access(project));
        expect((await dream.readRun(ownerId, 'local-dream', 'local-run'))!.findings).toEqual([]);
        await expect(dream.run({ownerProjectId: ownerId, dreamId: 'local-dream', sourceId: local.sourceId, operationId: 'local-revoked'})).rejects.toThrow();
        revokeLocal.mockRestore();
        await dream.run({ownerProjectId: ownerId, dreamId: 'local-dream', sourceId: local.sourceId, operationId: 'local-run'});
        expect((await dream.evidence.run(ownerId, 'local-dream', 'local-run'))?.execution?.taskId).toBe(localReceipt!.execution!.taskId);
        const selection = {projectId: source.project.id, connectionId: 'connection', path: '/notes/source.md', executor: {target}, maxOutputTokens: 256, runTokenLimit: 1000};
        grant.mockResolvedValueOnce(authority).mockResolvedValueOnce({...authority, revision: '2'});
        await expect(dream.addFile(ownerId, 'dream', 'configure', 1, selection)).rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
        expect((await dream.configs.read(ownerId, 'dream'))?.revision).toBe(1);
        const added = await dream.addFile(ownerId, 'dream', 'configure', 1, selection);
        expect(await dream.addFile(ownerId, 'dream', 'configure', 1, selection)).toEqual(added);
        await expect(dream.addFile(ownerId, 'dream', 'configure', 1, {...selection, path: '/notes/other.md'})).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        const bindRun = vi.spyOn(dream.registry, 'bindRun').mockRejectedValueOnce(new Error('DREAM_EXECUTION_BINDING_FAILED'));
        await expect(dream.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: added.sourceId, operationId: 'operation'}))
            .rejects.toThrow('DREAM_EXECUTION_BINDING_FAILED');
        expect(await dream.evidence.run(ownerId, 'dream', 'operation')).toBeNull();
        expect((await dream.history(ownerId, 'dream')).items).toMatchObject([{operationId: 'operation', state: 'failed', code: 'DREAM_EXECUTION_BINDING_FAILED'}]);
        await dream.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: added.sourceId, operationId: 'operation'});
        expect(bindRun).toHaveBeenCalled();
        const receipt = await dream.evidence.run(ownerId, 'dream', 'operation');
        expect(receipt?.execution?.taskId).toBeTruthy();
        expect(await dream.history(ownerId, 'dream')).toMatchObject({items: [{operationId: 'operation', state: 'settled'}], scanned: 1});
        const findings = (await dream.readRun(ownerId, 'dream', 'operation'))!.findings;
        expect(findings.map(finding => finding.kind)).toEqual(['fact', 'inference', 'suggestion']);
        const originalGet = runtime.projects.get.bind(runtime.projects), originalList = runtime.projects.remoteMounts!.list.bind(runtime.projects.remoteMounts);
        const getProject = vi.spyOn(runtime.projects, 'get').mockImplementation(async id => {
            const project = await originalGet(id);
            return id === source.project.id ? {...project, project: {...project.project, source: {kind: 'remote'} as never}} : project;
        });
        const listMounts = vi.spyOn(runtime.projects.remoteMounts!, 'list').mockImplementation(id => id === source.project.id
            ? [{at: '/', connectionId: 'connection'} as never] : originalList(id));
        const kanban = runtime.kanban!, actor = await kanban.currentPrincipal();
        const board = await kanban.create({id: 'dream-board', title: 'Dream board', scope: {kind: 'system'},
            members: [{...actor, responsibility: 'Manage', roles: ['worker', 'coordinator', 'reviewer']}], policy: {requireEstimate: false, review: 'assignee'}});
        await kanban.execute(board.id, {operationId: 'parent', expectedRevision: board.revision, command: {type: 'create-item',
            item: {id: 'parent', taskType: 'coordination', title: 'Parent', responsibility: 'Coordinate', acceptance: 'Done',
                externalRefs: [{system: 'nestos-remote-project', id: source.project.id}]}}});
        await kanban.execute(board.id, {operationId: 'closed-group', expectedRevision: (await kanban.read(board.id)).revision, command: {type: 'create-item',
            item: {id: 'closed-group', taskType: 'coordination', title: 'Closed group', responsibility: 'Coordinate', acceptance: 'Done',
                externalRefs: [{system: 'nestos-remote-project', id: source.project.id}]}}});
        await kanban.execute(board.id, {operationId: 'cancel-closed-group', expectedRevision: (await kanban.read(board.id)).revision,
            command: {type: 'cancel-item', itemId: 'closed-group', reason: 'No longer needed'}});
        expect((await dream.adoptionTargets(ownerId, board.id)).items.map(item => item.itemId)).toEqual(['parent']);
        const adoption = {ownerProjectId: ownerId, dreamId: 'dream', runId: 'operation', suggestionId: findings[2].id, operationId: 'adopt',
            boardId: board.id, targetProjectId: source.project.id, parentItemId: 'parent', title: 'Review types', responsibility: 'Review checks', acceptance: 'Checks reviewed'};
        vi.spyOn(dream.evidence, 'completeAdoption').mockRejectedValueOnce(new Error('injected write failure'));
        await expect(dream.adoptSuggestion(adoption)).rejects.toThrow('DREAM_ADOPTION_RECEIPT_UNAVAILABLE');
        expect(await dream.suggestionAdoptions(ownerId, 'dream', 'operation', findings[2].id)).toMatchObject([{state: 'prepared'}]);
        const adopted = await dream.adoptSuggestion(adoption);
        expect(await dream.adoptSuggestion(adoption)).toEqual(adopted);
        expect((await kanban.item(board.id, adopted.itemId)).item).toMatchObject({status: 'backlog', launch: {mode: 'manual'}, control: {action: 'pause'}});
        expect(await dream.suggestionAdoptions(ownerId, 'dream', 'operation', findings[2].id)).toMatchObject([{state: 'committed', itemId: adopted.itemId}]);
        expect(await dream.adoptionStatus(adoption)).toMatchObject({state: 'committed', itemId: adopted.itemId});
        const taskState = (await kanban.read(board.id)).items;
        const decisionRequest = {ownerProjectId: ownerId, dreamId: 'dream', runId: 'operation', suggestionId: findings[2].id,
            operationId: 'adopt-decision', boardId: board.id, targetProjectId: source.project.id, title: 'Review type checks'};
        const prepareDecision = vi.spyOn(dream.evidence, 'prepareDecisionAdoption');
        vi.spyOn(dream.evidence, 'completeDecisionAdoption').mockRejectedValueOnce(new Error('injected write failure'));
        await expect(dream.adoptDecision(decisionRequest)).rejects.toThrow('DREAM_ADOPTION_RECEIPT_UNAVAILABLE');
        const decision = await dream.adoptDecision(decisionRequest);
        expect(await dream.adoptDecision(decisionRequest)).toEqual(decision);
        expect(prepareDecision).toHaveBeenCalledOnce();
        expect((await kanban.record(board.id, decision.recordId))).toMatchObject({kind: 'decision', status: 'draft',
            content: 'Review type checks', rationale: 'TypeScript is used.', itemIds: [], externalRefs: expect.arrayContaining([
                {system: 'nestos-remote-project', id: source.project.id}, {system: 'nestos-primary-project', id: source.project.id},
            ])});
        expect(await dream.suggestionAdoptions(ownerId, 'dream', 'operation', findings[2].id)).toEqual(expect.arrayContaining([
            expect.objectContaining({kind: 'decision', state: 'committed', recordId: decision.recordId}),
        ]));
        await expect(kanban.runRecord!(board.id, {recordId: decision.recordId, operationId: 'run-dream-draft', expectedRevision: 1}))
            .rejects.toMatchObject({code: 'DECISION_NOT_CONFIRMED'});
        await kanban.execute(board.id, {operationId: 'confirm-dream-decision', expectedRevision: (await kanban.read(board.id)).revision,
            command: {type: 'review-record', recordId: decision.recordId, accept: true}});
        expect((await kanban.record(board.id, decision.recordId)).status).toBe('confirmed');
        expect((await kanban.read(board.id)).items).toEqual(taskState);
        getProject.mockRestore(); listMounts.mockRestore();
        expect(await dream.reviewFinding(ownerId, 'dream', findings[0].id, 'correct', 0,
            {action: 'correct', kind: 'inference', content: 'Likely uses TypeScript'})).toEqual({revision: 1});
        expect(await dream.findingHistory(ownerId, 'dream', findings[0].id, 1)).toMatchObject({previous: {content: 'Uses TypeScript'},
            result: {content: 'Likely uses TypeScript', origin: 'user-correction'}});
        const session = await runtime.sessionRepository.createSession('Memory consumer', owner.path);
        const unrelated = await runtime.sessionRepository.createSession('Other project', source.path);
        expect((await runtime.sessionRepository.getManifest(session)).folder).toBe((await runtime.projects.get(ownerId)).path + '/@sessions');
        expect((await runtime.sessionRepository.listSummaryPage(owner.path + '/@sessions', {limit: 50})).items.map(item => item.id)).toContain(session);
        expect((await dream.memorySessions(ownerId)).items).toEqual(expect.arrayContaining([expect.objectContaining({id: session, title: 'Memory consumer'})]));
        await expect(dream.bindSessionMemory(ownerId, 'dream', unrelated, 'operation', [added.sourceId], 'wrong-session', null))
            .rejects.toThrow('DREAM_SESSION_SCOPE_CHANGED');
        expect(await dream.bindSessionMemory(ownerId, 'dream', session, 'operation', [added.sourceId], 'bind-memory', null)).toEqual({revision: 1});
        expect(await dream.bindSessionMemory(ownerId, 'dream', session, 'operation', [added.sourceId], 'bind-memory', null)).toEqual({revision: 1});
        const memories = await dream.retrieveSessionMemory(session, 10);
        expect(memories).toHaveLength(2); expect(memories.some(item => item.content.includes('suggestion'))).toBe(false);
        grant.mockRejectedValue(new Error('revoked'));
        const revoked = await dream.readRun(ownerId, 'dream', 'operation');
        expect(revoked?.findings).toEqual([]);
        expect(revoked?.sources).toMatchObject([{status: 'unavailable', code: 'AUTHORIZATION_FAILED'}]);
        expect(await dream.retrieveSessionMemory(session, 10)).toEqual([]);
        await expect(dream.reviewFinding(ownerId, 'dream', findings[0].id, 'disable', 1, {action: 'disable'})).rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        await expect(dream.findingHistory(ownerId, 'dream', findings[0].id, 1)).rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        grant.mockResolvedValue(authority);
        expect(await dream.unbindSessionMemory(ownerId, session, 'unbind-memory', 1)).toEqual({revision: 2});
        expect(await dream.unbindSessionMemory(ownerId, session, 'unbind-memory', 1)).toEqual({revision: 2});
        expect(await dream.retrieveSessionMemory(session, 10)).toEqual([]);
        expect(await dream.bindSessionMemory(ownerId, 'dream', session, 'operation', [added.sourceId], 'rebind-memory', 2)).toEqual({revision: 3});
        expect(await dream.registry.find(receipt!.execution!.sessionId)).toMatchObject({ownerProjectId: ownerId, dreamId: 'dream', sourceId: added.sourceId});
        const sessionId = receipt!.execution!.sessionId;
        await expect(dream.authorizeScannerTool(sessionId)).rejects.toThrow('DREAM_SCANNER_TOOL_DISABLED');
        await expect(dream.authorizeScannerTool('unrelated-session')).resolves.toBeUndefined();
        await runtime.dispose(); vi.restoreAllMocks(); runtime = await openRuntime(); const restoredGrant = stubRemote();
        expect(await runtime.dream!.forSession(sessionId)).not.toBeNull();
        await runtime.dream!.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: added.sourceId, operationId: 'operation'});
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', 'operation'))?.execution?.taskId).toBe(receipt!.execution!.taskId);
        expect((await runtime.dream!.history(ownerId, 'dream')).items).toHaveLength(1);
        const second = await runtime.dream!.addFile(ownerId, 'dream', 'add-second', 2, {...selection, projectId: secondSource.project.id});
        restoredGrant.mockImplementation(async projectId => {if (projectId === secondSource.project.id) throw new Error('revoked'); return authority;});
        const partial = await runtime.dream!.runAll(ownerId, 'dream', 'batch', 3);
        expect(partial.results).toMatchObject([{sourceId: added.sourceId, status: 'settled'}, {sourceId: second.sourceId, status: 'failed'}]);
        restoredGrant.mockResolvedValue(authority);
        const retried = await runtime.dream!.runAll(ownerId, 'dream', 'batch', 3);
        expect(retried.results).toMatchObject([{sourceId: added.sourceId, status: 'settled'}, {sourceId: second.sourceId, status: 'settled'}]);
        expect(retried.results.map(result => result.operationId)).toEqual(partial.results.map(result => result.operationId));
        expect(await runtime.dream!.bindSessionMemory(ownerId, 'dream', session, 'operation', [added.sourceId], 'bind-new-config', 3)).toEqual({revision: 4});
        expect(await runtime.dream!.bindSessionMemory(ownerId, 'dream', session, retried.results[1].operationId, [second.sourceId], 'append-source', 4, true)).toEqual({revision: 5});
        expect(await runtime.dream!.bindSessionMemory(ownerId, 'dream', session, retried.results[1].operationId, [second.sourceId], 'append-source', 4, true)).toEqual({revision: 5});
        expect(await runtime.dream!.retrieveSessionMemory(session, 10)).toHaveLength(4);
        const secondFindings = (await runtime.dream!.readRun(ownerId, 'dream', retried.results[1].operationId))!.findings;
        await expect(runtime.dream!.mergeFindings(ownerId, 'dream', [findings[1].id, secondFindings[1].id], [1, 0], 'stale-merge')).rejects.toThrow('DREAM_REVIEW_CONFLICT');
        const merged = await runtime.dream!.mergeFindings(ownerId, 'dream', [findings[1].id, secondFindings[1].id], [0, 0], 'merge-memory');
        expect(await runtime.dream!.mergeFindings(ownerId, 'dream', [findings[1].id, secondFindings[1].id], [0, 0], 'merge-memory')).toEqual(merged);
        expect(await runtime.dream!.retrieveSessionMemory(session, 10)).toHaveLength(3);
        restoredGrant.mockImplementation(async projectId => {if (projectId === secondSource.project.id) throw new Error('revoked'); return authority;});
        expect(await runtime.dream!.retrieveSessionMemory(session, 10)).toHaveLength(2);
        await expect(runtime.dream!.mergeFindings(ownerId, 'dream', [findings[1].id, secondFindings[1].id], [0, 0], 'merge-memory')).rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        restoredGrant.mockResolvedValue(authority);
        await runtime.dream!.reviewFinding(ownerId, 'dream', findings[1].id, 'edit-merged', 0,
            {action: 'correct', kind: 'inference', content: 'A changed inference'});
        expect(await runtime.dream!.retrieveSessionMemory(session, 10)).toHaveLength(4);
        await runtime.dream!.mergeFindings(ownerId, 'dream', [findings[1].id, findings[0].id], [1, 1], 'merge-corrected');
        expect(await runtime.dream!.retrieveSessionMemory(session, 10)).toHaveLength(3);
        restoredGrant.mockImplementation(async projectId => {if (projectId === secondSource.project.id) throw new Error('revoked'); return authority;});
        expect((await runtime.dream!.setEnabled(ownerId, 'dream', 'pause', 3, false)).revision).toBe(4);
        await expect(runtime.dream!.runAll(ownerId, 'dream', 'while-paused', 4)).rejects.toThrow('DREAM_CONFIG_CONFLICT');
        expect((await runtime.dream!.setEnabled(ownerId, 'dream', 'resume', 4, true)).revision).toBe(5);
        expect((await runtime.dream!.removeFile(ownerId, 'dream', 'remove-revoked', 5, second.sourceId)).config.files).toHaveLength(1);
        const schedule = {state: 'active' as const, firstAt: Date.now() + 200, timeZone: 'UTC',
            cadence: {kind: 'interval' as const, milliseconds: 60_000}, trigger: 'fixed' as const, maxConcurrency: 1};
        const priorRuns = new Set((await runtime.dream!.history(ownerId, 'dream')).items.map(item => item.operationId));
        expect(await runtime.dream!.configureSchedule(ownerId, 'dream', 'schedule', 6, schedule)).toMatchObject({config: {revision: 7}, activation: 'ready'});
        await vi.waitFor(async () => expect((await runtime.dream!.history(ownerId, 'dream')).items.some(item =>
            !priorRuns.has(item.operationId) && item.operationId.startsWith('batch-') && item.state === 'settled' && item.sourceId === added.sourceId)).toBe(true), {timeout: 10000});
        const sources = [{id: 'adoption-source', boardId: board.id, itemId: adopted.itemId}];
        expect(await runtime.dream!.configureAdoptionSources(ownerId, 'dream', 'configure-adoption', 7, sources))
            .toMatchObject({revision: 8, config: {adoptions: sources}});
        expect(await runtime.dream!.configureAdoptionSources(ownerId, 'dream', 'configure-adoption', 7, sources)).toMatchObject({revision: 8});
        const liveGet = runtime.projects.get.bind(runtime.projects), liveList = runtime.projects.remoteMounts!.list.bind(runtime.projects.remoteMounts);
        const targetGet = vi.spyOn(runtime.projects, 'get').mockImplementation(async id => {
            const project = await liveGet(id);
            return id === source.project.id ? {...project, project: {...project.project, source: {kind: 'remote'} as never}} : project;
        });
        const targetList = vi.spyOn(runtime.projects.remoteMounts!, 'list').mockImplementation(id => id === source.project.id
            ? [{at: '/', root: '/', alias: 'source', connectionId: 'connection'} as never] : liveList(id));
        const currentKanban = runtime.kanban!;
        let commandNumber = 0;
        const command = async (value: import('@nestos/kanban/contracts').KanbanCommand) => {
            for (let attempt = 0; ; attempt++) {
                const boardState = await currentKanban.read(board.id);
                const commandValue = value.type === 'publish-plan' ? {...value, plan: {...value.plan, items: value.plan.items.map(item =>
                    ({...item, expectedRevision: boardState.items.find(row => row.id === item.id)?.revision}))}} : value;
                try {return await currentKanban.execute(board.id, {operationId: `adoption-test-${++commandNumber}`,
                    expectedRevision: boardState.revision, command: commandValue});}
                catch (error) {if ((error as {code?: string}).code !== 'REVISION_CONFLICT' || attempt >= 5) throw error;}
            }
        };
        await command({type: 'request-control', itemId: adopted.itemId, controlId: 'resume-adoption', action: 'resume'});
        await command({type: 'control-receipt', itemId: adopted.itemId, controlId: 'resume-adoption', state: 'resumed'});
        const actualItem = (await currentKanban.item(board.id, adopted.itemId)).item;
        expect(actualItem).toMatchObject({status: 'backlog', control: {action: 'resume', state: 'resumed'}});
        await command({type: 'publish-plan', plan: {schema: 'kanban.plan/1', id: 'adoption-plan', revision: 1, sealed: true,
            rootItemId: 'parent', items: [{id: adopted.itemId, expectedRevision: actualItem.revision, title: actualItem.title,
                responsibility: actualItem.responsibility, acceptance: actualItem.acceptance, assignee: actor, dependsOn: [], outputs: ['result']}]}});
        await command({type: 'prepare-dispatch', itemId: adopted.itemId, dispatchId: 'adoption-dispatch'});
        const dispatch = (await currentKanban.workflow(board.id)).dispatches['adoption-dispatch'];
        const actualJournal = new KanbanAutomationJournal(await runtime.vfs.openFileSystem('/'), kanbanJournalOptions);
        await actualJournal.open();
        const outputs = await actualJournal.artifact('adoption-dispatch', {content: 'TypeScript is used.'});
        await command({type: 'observe-execution', dispatchId: dispatch.id, fence: dispatch.fence, outcome: 'succeeded',
            executionSessionId: 'adoption-execution', outputs});
        if ((await currentKanban.workflow(board.id)).dispatches[dispatch.id].outcome === 'succeeded')
            await command({type: 'accept-execution', dispatchId: dispatch.id, accept: true});
        await command({type: 'append-record', record: {id: 'decision-source', kind: 'decision', title: 'TypeScript is used.',
            content: 'Private decision body', rationale: 'Private rationale', itemIds: [], sources: [], externalRefs: [{system: 'nestos-remote-project', id: source.project.id}]}});
        await command({type: 'review-record', recordId: 'decision-source', accept: true});
        await command({type: 'create-item', item: {id: 'summary-task', taskType: 'execution', title: 'TypeScript is used.',
            responsibility: 'Private task responsibility', acceptance: 'Private acceptance', externalRefs: [{system: 'nestos-remote-project', id: source.project.id}]},
            planning: {parentId: 'parent', kind: 'task', priority: 2, dependencies: [], references: []}});
        targetGet.mockRestore(); targetList.mockRestore();
        const configuredBatch = await runtime.dream!.runAll(ownerId, 'dream', 'batch-with-adoption', 8);
        const adoptionResult = configuredBatch.results.find(item => item.sourceId === 'adoption-source')!;
        if (adoptionResult.status === 'failed') throw new Error(adoptionResult.code);
        expect(adoptionResult).toMatchObject({status: 'settled'});
        const adoptionRun = await runtime.dream!.evidence.run(ownerId, 'dream', adoptionResult.operationId);
        expect(adoptionRun?.execution?.taskId).toBeTruthy();
        expect((await runtime.dream!.evidence.watermark(ownerId, 'dream', 'adoption-source'))?.cursor).toBeTruthy();
        expect((await runtime.dream!.readRun(ownerId, 'dream', adoptionResult.operationId))?.findings).toHaveLength(3);
        expect(await runtime.dream!.runAll(ownerId, 'dream', 'batch-with-adoption', 8)).toEqual(configuredBatch);
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', adoptionResult.operationId))?.execution).toEqual(adoptionRun?.execution);
        const port = await runtime.dream!.configuredAdoptionPort(ownerId, 'dream', 'adoption-source', adoption);
        const bound = {id: 'adoption-source', projectId: source.project.id, connectionId: 'kanban-adoption', cursor: null};
        await expect(port.authorize(bound)).resolves.toBeDefined();
        await expect(port.read(bound, 1)).resolves.toMatchObject({items: ['{"content":"TypeScript is used."}']});
        await actualJournal.drain();
        restoredGrant.mockRejectedValue(new Error('revoked'));
        await expect(port.authorize(bound)).rejects.toThrow();
        expect((await runtime.dream!.readRun(ownerId, 'dream', adoptionResult.operationId))?.findings).toEqual([]);
        restoredGrant.mockResolvedValue(authority);
        await expect(runtime.dream!.configureAdoptionSources(ownerId, 'dream', 'wrong-adoption', 8,
            [{id: 'wrong', boardId: board.id, itemId: 'parent'}])).rejects.toThrow('DREAM_SOURCE_BINDING_CHANGED');
        await runtime.dispose(); vi.restoreAllMocks(); runtime = await openRuntime(); const finalGrant = stubRemote();
        expect(await runtime.dream!.forSession(adoptionRun!.execution!.sessionId)).not.toBeNull();
        expect(await runtime.dream!.runAll(ownerId, 'dream', 'batch-with-adoption', 8)).toEqual(configuredBatch);
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', adoptionResult.operationId))?.execution).toEqual(adoptionRun?.execution);
        const decisions = [{id: 'decision-source', projectId: source.project.id, connectionId: 'connection', boardId: board.id,
            recordId: 'decision-source', scannerSourceId: added.sourceId}];
        expect((await runtime.dream!.kanbanSourceCandidates(ownerId, source.project.id, 'connection', board.id, 'decision')).items)
            .toContainEqual(expect.objectContaining({id: 'decision-source'}));
        expect(await runtime.dream!.configureDecisionSources(ownerId, 'dream', 'configure-decision', 8, decisions)).toMatchObject({revision: 9});
        const decisionBatch = await runtime.dream!.runAll(ownerId, 'dream', 'decision-batch', 9);
        const decisionResult = decisionBatch.results.find(item => item.sourceId === 'decision-source')!;
        if (decisionResult.status === 'failed') throw new Error(decisionResult.code);
        const decisionRun = await runtime.dream!.evidence.run(ownerId, 'dream', decisionResult.operationId);
        expect(decisionRun?.execution?.taskId).toBeTruthy();
        expect((await runtime.dream!.readRun(ownerId, 'dream', decisionResult.operationId))?.findings).toHaveLength(3);
        expect((await runtime.dream!.evidence.watermark(ownerId, 'dream', 'decision-source'))?.cursor).toBeTruthy();
        expect(await runtime.dream!.runAll(ownerId, 'dream', 'decision-batch', 9)).toEqual(decisionBatch);
        const nextDecision = await runtime.dream!.runAll(ownerId, 'dream', 'decision-unchanged', 9);
        const next = nextDecision.results.find(item => item.sourceId === 'decision-source')!;
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', next.operationId))?.execution).toBeUndefined();
        const watermark = await runtime.dream!.evidence.watermark(ownerId, 'dream', 'decision-source');
        finalGrant.mockRejectedValue(new Error('revoked'));
        expect((await runtime.dream!.readRun(ownerId, 'dream', decisionResult.operationId))?.findings).toEqual([]);
        await expect(runtime.dream!.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: 'decision-source', operationId: 'decision-revoked'})).rejects.toThrow();
        expect(await runtime.dream!.evidence.watermark(ownerId, 'dream', 'decision-source')).toEqual(watermark);
        await runtime.dispose(); vi.restoreAllMocks(); runtime = await openRuntime(); const taskGrant = stubRemote();
        expect(await runtime.dream!.forSession(decisionRun!.execution!.sessionId)).not.toBeNull();
        expect(await runtime.dream!.runAll(ownerId, 'dream', 'decision-batch', 9)).toEqual(decisionBatch);
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', decisionResult.operationId))?.execution).toEqual(decisionRun?.execution);
        const tasks = [{id: 'task-source', projectId: source.project.id, connectionId: 'connection', boardId: board.id,
            itemId: 'summary-task', scannerSourceId: added.sourceId}];
        expect((await runtime.dream!.kanbanSourceCandidates(ownerId, source.project.id, 'connection', board.id, 'task')).items)
            .toContainEqual(expect.objectContaining({id: 'summary-task'}));
        expect(await runtime.dream!.configureTaskSources(ownerId, 'dream', 'configure-task', 9, tasks)).toMatchObject({revision: 10});
        const taskBatch = await runtime.dream!.runAll(ownerId, 'dream', 'task-batch', 10);
        const taskResult = taskBatch.results.find(item => item.sourceId === 'task-source')!;
        if (taskResult.status === 'failed') throw new Error(taskResult.code);
        const taskRun = await runtime.dream!.evidence.run(ownerId, 'dream', taskResult.operationId);
        expect(taskRun?.execution?.taskId).toBeTruthy();
        expect((await runtime.dream!.readRun(ownerId, 'dream', taskResult.operationId))?.findings).toHaveLength(3);
        const taskWatermark = await runtime.dream!.evidence.watermark(ownerId, 'dream', 'task-source');
        expect(taskWatermark?.cursor).toBeTruthy();
        expect(await runtime.dream!.runAll(ownerId, 'dream', 'task-batch', 10)).toEqual(taskBatch);
        const unchangedTask = (await runtime.dream!.runAll(ownerId, 'dream', 'task-unchanged', 10)).results.find(item => item.sourceId === 'task-source')!;
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', unchangedTask.operationId))?.execution).toBeUndefined();
        taskGrant.mockRejectedValue(new Error('revoked'));
        expect((await runtime.dream!.readRun(ownerId, 'dream', taskResult.operationId))?.findings).toEqual([]);
        await expect(runtime.dream!.kanbanSourceCandidates(ownerId, source.project.id, 'connection', board.id, 'task')).rejects.toThrow();
        await expect(runtime.dream!.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: 'task-source', operationId: 'task-revoked'})).rejects.toThrow();
        expect(await runtime.dream!.evidence.watermark(ownerId, 'dream', 'task-source')).toEqual(taskWatermark);
        taskGrant.mockResolvedValue(authority);
        const localProject = await runtime.projects.personal();
        const localSession = await runtime.sessionRepository.createSession('Selected session', localProject.path);
        await new RoundLog(runtime.sessionRepository, localSession).append('main', {id: 'session-round', kind: 'chat', historyParentIds: [],
            origin: 'user', status: 'completed', createdAt: 1, input: [{role: 'user', content: 'TypeScript is used.'}], output: []});
        const sessions = [{id: 'session-source', projectId: localProject.project.id, connectionId: 'dream-local', sessionId: localSession,
            maxRounds: 2, scannerSourceId: added.sourceId}];
        await expect(runtime.dream!.configureSessionSources(ownerId, 'dream', 'wrong-session-project', 10,
            [{...sessions[0], projectId: ownerId}])).rejects.toThrow('DREAM_SESSION_SCOPE_CHANGED');
        expect(await runtime.dream!.configureSessionSources(ownerId, 'dream', 'configure-session', 10, sessions)).toMatchObject({revision: 11});
        const sessionInput = {ownerProjectId: ownerId, dreamId: 'dream', sourceId: 'session-source', operationId: 'session-operation'};
        const settle = vi.spyOn(runtime.dream!.evidence, 'settle').mockRejectedValueOnce(new Error('injected write failure'));
        await expect(runtime.dream!.run(sessionInput)).rejects.toThrow('DREAM_SETTLEMENT_FAILED');
        expect(await runtime.dream!.evidence.watermark(ownerId, 'dream', 'session-source')).toBeNull();
        const dreamEntry = await (runtime.dream as unknown as {open(owner: string, dream: string): Promise<{twin: {snapshot(): Promise<{jobs: Array<{data: {taskId?: string; scanScope?: {planId: string}}}>}>}}>}).open(ownerId, 'dream');
        const priorTask = (await dreamEntry.twin.snapshot()).jobs.find(job => job.data.scanScope?.planId === adoptionScannerIds(ownerId, 'dream', 'session-source').planId)?.data.taskId;
        expect(priorTask).toBeTruthy();
        await runtime.dream!.run(sessionInput); settle.mockRestore();
        const sourceRun = await runtime.dream!.evidence.run(ownerId, 'dream', sessionInput.operationId);
        expect(sourceRun?.execution?.taskId).toBe(priorTask);
        expect((await runtime.dream!.readRun(ownerId, 'dream', sessionInput.operationId))?.findings).toHaveLength(3);
        const sessionConsumer = await runtime.sessionRepository.createSession('Session source consumer', owner.path);
        expect(await runtime.dream!.bindSessionMemory(ownerId, 'dream', sessionConsumer, sessionInput.operationId,
            ['session-source'], 'bind-session-source', null)).toEqual({revision: 1});
        expect((await runtime.dream!.retrieveSessionMemory(sessionConsumer, 10)).length).toBeGreaterThan(0);
        await runtime.dream!.run(sessionInput);
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', sessionInput.operationId))?.execution).toEqual(sourceRun?.execution);
        const unchangedSession = (await runtime.dream!.runAll(ownerId, 'dream', 'session-unchanged', 11)).results.find(item => item.sourceId === 'session-source')!;
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', unchangedSession.operationId))?.execution).toBeUndefined();
        const sessionWatermark = await runtime.dream!.evidence.watermark(ownerId, 'dream', 'session-source');
        const workspaceAccess = runtime.projects.workspaceAccess.bind(runtime.projects);
        const revokeSession = vi.spyOn(runtime.projects, 'workspaceAccess').mockImplementation(project =>
            project.project.id === localProject.project.id ? 'ro' : workspaceAccess(project));
        expect((await runtime.dream!.readRun(ownerId, 'dream', sessionInput.operationId))?.findings).toEqual([]);
        expect(await runtime.dream!.retrieveSessionMemory(sessionConsumer, 10)).toEqual([]);
        await expect(runtime.dream!.run({ownerProjectId: ownerId, dreamId: 'dream', sourceId: 'session-source', operationId: 'session-revoked'})).rejects.toThrow();
        expect(await runtime.dream!.evidence.watermark(ownerId, 'dream', 'session-source')).toEqual(sessionWatermark);
        revokeSession.mockRestore();
        const originalMounts = runtime.projects.remoteMounts!.list.bind(runtime.projects.remoteMounts);
        const remoteMount = vi.spyOn(runtime.projects.remoteMounts!, 'list').mockImplementation(id => id === source.project.id
            ? [{at: '/', root: '/', alias: 'source', connectionId: 'connection', serverId: 'node', serverProjectId: 'remote'} as never] : originalMounts(id));
        const history = {version: 1, session: {id: 'remote-session', title: 'Remote', cwd: null, status: 'idle', createdAt: 1, updatedAt: 2,
            resumable: true, historyRevision: 'a'.repeat(64)}, revision: 'b'.repeat(64), omittedUnclassified: 0,
            messages: [{id: 'message', turnId: 'turn', role: 'user', text: 'TypeScript is used.'}], nextCursor: 'older', scan: {historyBytes: 100, contextBytes: 10}};
        const nativeDigest = vi.fn(async (..._args: unknown[]) => structuredClone(history)), nativeRead = vi.fn();
        const profiles = vi.fn(async () => ({profiles: [{id: 'profile', kind: 'Codex', projectRuntime: true, capabilities: {sessionDigest: true}}]}));
        const nativeList = vi.fn(async () => ({sessions: [{id: 'remote-session', title: 'Research'}], nextCursor: null}));
        const openHarness = vi.spyOn(runtime.projects.remoteMounts!, 'projectHarness').mockResolvedValue({digest: nativeDigest, read: nativeRead, profiles, list: nativeList, close: async () => {}} as never);
        const remoteSession = {id: 'remote-session-source', projectId: source.project.id, connectionId: 'connection', sessionId: 'remote-session',
            profileId: 'profile', maxRounds: 2, scannerSourceId: added.sourceId};
        expect(await runtime.dream!.remoteSessionProfiles(ownerId, source.project.id, 'connection')).toEqual([{id: 'profile', name: 'Codex'}]);
        expect(await runtime.dream!.remoteSessionCandidates(ownerId, source.project.id, 'connection', 'profile')).toMatchObject({items: [{id: 'remote-session', title: 'Research'}], returned: 1});
        expect(nativeList.mock.calls[0][1]).toMatchObject({limit: 50});
        nativeDigest.mockResolvedValueOnce({...structuredClone(history), session: {...history.session, historyRevision: undefined}} as never);
        await expect(runtime.dream!.configureSessionSources(ownerId, 'dream', 'old-remote-session', 11, [...sessions, remoteSession]))
            .rejects.toThrow('DREAM_SESSION_DIGEST_UNAVAILABLE');
        expect(await runtime.dream!.configureSessionSources(ownerId, 'dream', 'configure-remote-session', 11, [...sessions, remoteSession])).toMatchObject({revision: 12});
        const remoteInput = {ownerProjectId: ownerId, dreamId: 'dream', sourceId: remoteSession.id, operationId: 'remote-session-run'};
        const remoteSettle = vi.spyOn(runtime.dream!.evidence, 'settle').mockRejectedValueOnce(new Error('injected write failure'));
        await expect(runtime.dream!.run(remoteInput)).rejects.toThrow('DREAM_SETTLEMENT_FAILED');
        expect(await runtime.dream!.evidence.watermark(ownerId, 'dream', remoteSession.id)).toBeNull();
        const remoteTask = (await dreamEntry.twin.snapshot()).jobs.find(job => job.data.scanScope?.planId === adoptionScannerIds(ownerId, 'dream', remoteSession.id).planId)?.data.taskId;
        await runtime.dream!.run(remoteInput);
        remoteSettle.mockRestore();
        const remoteRun = await runtime.dream!.evidence.run(ownerId, 'dream', remoteInput.operationId);
        expect(remoteRun?.execution?.taskId).toBe(remoteTask);
        expect((await runtime.dream!.readRun(ownerId, 'dream', remoteInput.operationId))?.findings).toHaveLength(3);
        await runtime.dream!.run(remoteInput);
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', remoteInput.operationId))?.execution).toEqual(remoteRun?.execution);
        const fullReads = nativeDigest.mock.calls.filter(call => !(call[2] as {metadataOnly?: boolean})?.metadataOnly).length;
        await runtime.dream!.run({...remoteInput, operationId: 'remote-session-unchanged'});
        expect((await runtime.dream!.evidence.run(ownerId, 'dream', 'remote-session-unchanged'))?.execution).toBeUndefined();
        expect(nativeDigest.mock.calls.filter(call => !(call[2] as {metadataOnly?: boolean})?.metadataOnly)).toHaveLength(fullReads);
        expect(nativeRead).not.toHaveBeenCalled();
        expect(nativeDigest.mock.calls.every(call => !(call[2] as {cursor?: string} | undefined)?.cursor)).toBe(true);
        expect(nativeDigest.mock.calls.some(call => (call[2] as {expectedRevision?: string} | undefined)?.expectedRevision === history.revision)).toBe(true);
        taskGrant.mockRejectedValue(new Error('revoked'));
        expect((await runtime.dream!.readRun(ownerId, 'dream', remoteInput.operationId))?.findings).toEqual([]);
        await expect(runtime.dream!.remoteSessionCandidates(ownerId, source.project.id, 'connection', 'profile')).rejects.toThrow();
        await expect(runtime.dream!.run({...remoteInput, operationId: 'remote-session-revoked'})).rejects.toThrow();
        openHarness.mockRestore(); remoteMount.mockRestore();
        taskGrant.mockResolvedValue(authority);
        const currentDream = runtime.dream!;
        const changes = [{id: 'changes', projectId: localProject.project.id, connectionId: 'dream-local',
            directory: '/notes', exclude: ['/notes/excluded'], maxEntries: 20, scannerSourceId: added.sourceId}];
        expect(await currentDream.configureChangeSources(ownerId, 'dream', 'configure-changes', 12, changes)).toMatchObject({revision: 13});
        const changeInput = {ownerProjectId: ownerId, dreamId: 'dream', sourceId: 'changes', operationId: 'change-run'};
        const changeSettle = vi.spyOn(currentDream.evidence, 'settle').mockRejectedValueOnce(new Error('injected write failure'));
        await expect(currentDream.run(changeInput)).rejects.toThrow('DREAM_SETTLEMENT_FAILED');
        expect(await currentDream.evidence.watermark(ownerId, 'dream', 'changes')).toBeNull();
        const changeTask = (await dreamEntry.twin.snapshot()).jobs.find(job => job.data.scanScope?.planId === adoptionScannerIds(ownerId, 'dream', 'changes').planId)?.data.taskId;
        expect(changeTask).toBeTruthy();
        await currentDream.run(changeInput); changeSettle.mockRestore();
        expect((await currentDream.evidence.run(ownerId, 'dream', 'change-run'))?.execution?.taskId).toBe(changeTask);
        await currentDream.run({...changeInput, operationId: 'change-unchanged'});
        expect((await currentDream.evidence.run(ownerId, 'dream', 'change-unchanged'))?.execution).toBeUndefined();
        const edit = await runtime.projects.openFiles(localProject.path);
        await edit.fs.driver.writeContent('/notes/local.md', 'TypeScript is used. Updated.'); await edit.dispose();
        await currentDream.run({...changeInput, operationId: 'change-updated'});
        expect((await currentDream.evidence.run(ownerId, 'dream', 'change-updated'))?.execution?.taskId).toBeTruthy();
        const changeWatermark = await currentDream.evidence.watermark(ownerId, 'dream', 'changes');
        const revokeChanges = vi.spyOn(runtime.projects, 'workspaceAccess').mockImplementation(project =>
            project.project.id === localProject.project.id ? 'ro' : workspaceAccess(project));
        expect((await currentDream.readRun(ownerId, 'dream', 'change-updated'))?.findings).toEqual([]);
        await expect(currentDream.run({...changeInput, operationId: 'change-revoked'})).rejects.toThrow();
        expect(await currentDream.evidence.watermark(ownerId, 'dream', 'changes')).toEqual(changeWatermark);
        revokeChanges.mockRestore();
    } finally {vi.restoreAllMocks(); await runtime.dispose(); await closeBackend();}
}, 60000);

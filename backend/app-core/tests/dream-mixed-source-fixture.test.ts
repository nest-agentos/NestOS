import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import {RoundLog} from '@nestos/llm-session';
import {sha256HexSync} from '@nestos/common';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

it('jointly consolidates two project files, a session and an isolated Git commit into one existing memory', async () => {
    const gitDir = await mkdtemp(path.join(tmpdir(), 'dream-git-fixture-'));
    const git = (...args: string[]) => execFileSync('git', args, {cwd: gitDir, encoding: 'utf8'});
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(path.join(gitDir, 'note.md'), 'TypeScript is used.');
    git('add', 'note.md'); git('commit', '-q', '-m', 'TypeScript is used.');
    const backend = new MemoryBackend(); await backend.init();
    for (const directory of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(directory);
    const write = (name: string, value: unknown) => backend.write(name, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    let revision = false, gitOnly = false;
    const fetch = vi.fn(async (_url: unknown, options: any) => {
        const request = JSON.parse(options.body), targetId = gitOnly ? 'git-memory' : 'memory1';
        const content = JSON.stringify({proposals: [{id: gitOnly ? 'git-proposal' : revision ? 'updated-proposal' : 'old-proposal',
            targetId, status: 'ready', affectedMemoryIds: [targetId], changes: [{id: targetId, content: revision ? 'Updated cross-source rule.' : 'Old rule.'}]}]});
        const usage = {prompt_tokens: 50, completion_tokens: 50, total_tokens: 100};
        return request.stream ? new Response(`data: ${JSON.stringify({id: 'response', choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: 'stop'}], usage})}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}})
            : new Response(JSON.stringify({id: 'response', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage}), {headers: {'content-type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetch);
    const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
    try {
        const a = await runtime.projects.create('Project A'), b = await runtime.projects.create('Project B');
        for (const project of [a, b]) {
            const files = await runtime.projects.openFiles(project.path);
            await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'}); await files.dispose();
        }
        const dream = runtime.dream!;
        (dream as any).options.readCommits = async () => {
            const text = git('log', '-1', '--format=%H %s').trim(); return {text, hash: sha256HexSync(text), scanned: 1, directories: 1};
        };
        await dream.create(a.project.id, 'dream', 'create', 'Dream'); await dream.setModelConnection(a.project.id, 'dream', 'default');
        const scanner: FlowDraft = {id: 'mixed-scan' as never, name: 'Scanner', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]}}}],
            edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        const consolidation: FlowDraft = {id: 'mixed-consolidate' as never, name: 'Consolidate', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'agent' as never, name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
                config: {connectionId: 'default', instruction: '${input.prompt}', stream: false, approval: 'none', toolIds: [], skillIds: []}}],
            edges: [], outputs: {result: {value: '${nodes.agent.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [scanner, consolidation]});
        const targets = await dream.scannerTargets(a.project.id, 'dream');
        const scanTarget = targets.find(item => item.target.id === scanner.id)!.target, target = targets.find(item => item.target.id === consolidation.id)!.target;
        const first = await dream.addFile(a.project.id, 'dream', 'add-a', 1, {projectId: a.project.id, connectionId: 'dream-local', path: '/notes/source.md',
            executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        let config = await dream.configureConsolidation(a.project.id, 'dream', 'configure', first.config.revision, {target});
        expect((await dream.runAll(a.project.id, 'dream', 'old-batch', config.revision)).results[0].status).toBe('settled');
        const old = (await dream.pendingConsolidation(a.project.id, 'dream', a.project.id)).items[0];
        const committed = await dream.commitConsolidation(a.project.id, 'dream', 'old-commit', null, [{id: old.id, revision: old.revision}]);
        const second = await dream.addFile(a.project.id, 'dream', 'add-b', config.revision, {projectId: b.project.id, connectionId: 'dream-local', path: '/notes/source.md',
            executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        const sessionId = await runtime.sessionRepository.createSession('Fixture', a.path);
        await new RoundLog(runtime.sessionRepository, sessionId).append('main', {id: 'round1', kind: 'chat', historyParentIds: [], origin: 'user', status: 'completed',
            createdAt: 1, input: [{role: 'user', content: 'TypeScript is used.'}], output: []});
        config = await dream.configureSessionSources(a.project.id, 'dream', 'session', second.config.revision,
            [{id: 'session-source', projectId: a.project.id, connectionId: 'dream-local', sessionId, maxRounds: 2, scannerSourceId: first.sourceId}]);
        config = await dream.configureChangeSources(a.project.id, 'dream', 'git', config.revision,
            [{id: 'git-source', projectId: b.project.id, connectionId: 'dream-local', directory: '/', exclude: [], maxEntries: 10, commits: true, scannerSourceId: first.sourceId}]);
        config = await dream.configureConsolidation(a.project.id, 'dream', 'joint', config.revision, {target, crossProject: true});
        const edit = await runtime.projects.openFiles(a.path);
        await edit.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Updated.'); await edit.dispose();
        revision = true;
        const result = await dream.runAll(a.project.id, 'dream', 'joint-batch', config.revision, [first.sourceId, second.sourceId, 'session-source', 'git-source']);
        expect(result.results).toHaveLength(4); expect(result.results.map(item => item.status)).toEqual(['settled', 'settled', 'settled', 'settled']);
        const scope = 'joint-' + sha256HexSync(JSON.stringify([a.project.id, b.project.id].sort()));
        const proposed = (await dream.pendingConsolidation(a.project.id, 'dream', scope)).items[0];
        expect(proposed.targetId).toBe('memory1'); expect(proposed.evidenceIds).toHaveLength(4);
        expect(proposed.requiredScopes).toEqual([first.sourceId, second.sourceId, 'session-source', 'git-source'].sort());
        const evidence = await Promise.all(proposed.evidenceIds.map(id => dream.readProposalEvidence(a.project.id, 'dream', proposed.id, id)));
        expect(new Set(evidence.map(item => item.sourceId))).toEqual(new Set([first.sourceId, second.sourceId, 'session-source', 'git-source']));
        const before = await runtime.sessionRepository.createSession('Before approval', a.path);
        expect((await dream.retrieveSessionMemory(before, 10)).map(item => item.content)).toEqual(['Old rule.']);
        await dream.commitConsolidation(a.project.id, 'dream', 'joint-commit', committed.version, [{id: proposed.id, revision: proposed.revision}]);
        expect((await dream.activeConsolidation(a.project.id, 'dream'))?.topics).toMatchObject([{id: 'memory1', content: 'Updated cross-source rule.', kind: 'constraint', priority: 0}]);
        const after = await runtime.sessionRepository.createSession('After approval', a.path);
        expect(await dream.retrieveSessionMemory(after, 10)).toEqual([]);
        let bindingRevision: number | null = null;
        for (const item of result.results) {
            const binding = await dream.bindSessionMemory(a.project.id, 'dream', after, item.operationId, [item.sourceId],
                `bind-${item.sourceId}`, bindingRevision, bindingRevision !== null);
            bindingRevision = binding.revision;
            if (bindingRevision === 1) expect(await dream.retrieveSessionMemory(after, 10)).toEqual([]);
        }
        expect((await dream.retrieveSessionMemory(after, 10)).map(item => item.content)).toEqual(['Updated cross-source rule.']);
        expect((await dream.searchSessionMemory(after, 'cross-source')).map(item => item.content)).toEqual(['Updated cross-source rule.']);
        const bOnly = await runtime.sessionRepository.createSession('B only', b.path);
        expect(await dream.retrieveSessionMemory(bOnly, 10)).toEqual([]);
        const authorize = (dream as any).authorizeConsolidationSource.bind(dream);
        const revoke = vi.spyOn(dream as any, 'authorizeConsolidationSource').mockImplementation((...args: unknown[]) => {
            if (args[3] === second.sourceId) throw new Error('DREAM_AUTHORIZATION_CHANGED'); return authorize(...args);
        });
        expect(await dream.retrieveSessionMemory(after, 10)).toEqual([]);
        expect(await dream.searchSessionMemory(after, 'cross-source')).toEqual([]);
        revoke.mockRestore();
        const store = (dream as any).evidence;
        const beforeUnselected = await Promise.all([first.sourceId, second.sourceId, 'session-source'].map(id => store.watermark(a.project.id, 'dream', id)));
        await writeFile(path.join(gitDir, 'note.md'), 'TypeScript is used. Again.');
        git('add', 'note.md'); git('commit', '-q', '-m', 'TypeScript is used. Again.');
        gitOnly = true;
        const onlyGit = await dream.runAll(a.project.id, 'dream', 'git-only', config.revision, ['git-source']);
        expect(onlyGit.results).toMatchObject([{sourceId: 'git-source', status: 'settled'}]);
        expect(await Promise.all([first.sourceId, second.sourceId, 'session-source'].map(id => store.watermark(a.project.id, 'dream', id)))).toEqual(beforeUnselected);
        await dream.create(b.project.id, 'dream-b', 'create-b', 'Dream B');
        await dream.setModelConnection(b.project.id, 'dream-b', 'default');
        const bScanner = await dream.addFile(b.project.id, 'dream-b', 'add-b-own', 1, {projectId: b.project.id,
            connectionId: 'dream-local', path: '/notes/source.md', executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        vi.useFakeTimers({toFake: ['Date']});
        vi.setSystemTime(new Date('2026-11-25T09:59:00Z'));
        const schedule = {state: 'active' as const, trigger: 'fixed' as const, maxConcurrency: 1, firstAt: 0, timeZone: 'Asia/Shanghai',
            cadence: {kind: 'calendar' as const, weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 18, minute: 0}};
        const scheduleA = await dream.configureSchedule(a.project.id, 'dream', 'schedule-a', config.revision, schedule);
        const scheduleB = await dream.configureSchedule(b.project.id, 'dream-b', 'schedule-b', bScanner.config.revision, {...schedule, timeZone: 'America/New_York'});
        expect(scheduleA.activation).toBe('ready'); expect(scheduleB.activation).toBe('ready');
        expect((await dream.openView(a.project.id, 'dream'))?.scheduleStatus?.nextAt).toBe(Date.parse('2026-11-25T10:00:00Z'));
        expect((await dream.openView(b.project.id, 'dream-b'))?.scheduleStatus?.nextAt).toBe(Date.parse('2026-11-25T23:00:00Z'));
        expect((await dream.runAll(a.project.id, 'dream', 'manual-a', scheduleA.config.revision, ['git-source'])).results[0].status).toBe('settled');
        expect((await dream.runAll(b.project.id, 'dream-b', 'manual-b', scheduleB.config.revision, [bScanner.sourceId])).results[0].status).toBe('settled');
        const beforeA = new Set((await dream.history(a.project.id, 'dream')).items.map(item => item.operationId));
        const beforeB = new Set((await dream.history(b.project.id, 'dream-b')).items.map(item => item.operationId));
        vi.setSystemTime(new Date('2026-11-25T10:00:00Z'));
        await vi.waitFor(async () => {
            const [historyA, historyB] = await Promise.all([dream.history(a.project.id, 'dream'), dream.history(b.project.id, 'dream-b')]);
            expect(historyA.items.some(item => !beforeA.has(item.operationId) && item.operationId.startsWith('batch-') && item.state === 'settled')).toBe(true);
            expect(historyB.items.some(item => !beforeB.has(item.operationId) && item.operationId.startsWith('batch-'))).toBe(false);
        }, {timeout: 30000, interval: 100});
        vi.setSystemTime(new Date('2026-11-25T23:00:00Z'));
        await vi.waitFor(async () => {
            const [historyA, historyB] = await Promise.all([dream.history(a.project.id, 'dream'), dream.history(b.project.id, 'dream-b')]);
            expect(historyA.items.some(item => !beforeA.has(item.operationId) && item.operationId.startsWith('batch-') && item.state === 'settled')).toBe(true);
            expect(historyB.items.some(item => !beforeB.has(item.operationId) && item.operationId.startsWith('batch-') && item.state === 'settled')).toBe(true);
        }, {timeout: 30000, interval: 100});
    } finally {await runtime.dispose(); await rm(gitDir, {recursive: true, force: true}); vi.unstubAllGlobals(); vi.useRealTimers();}
}, 210000);

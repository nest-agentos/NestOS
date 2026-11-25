import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import {MemoryCommitStore} from '@nestos/dream/vfs';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';

it('assembles authorized constraints and topic pointers within default, custom, host and session budgets', async () => {
    const backend = new MemoryBackend(); await backend.init();
    for (const directory of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(directory);
    const write = (name: string, value: unknown) => backend.write(name, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false,
        dreamHotLoadTokenLimit: 3000, remoteSourceProvider});
    try {
        const project = await runtime.projects.create('Owner'), owner = project.project.id, dream = runtime.dream!;
        const files = await runtime.projects.openFiles(project.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'}); await files.dispose();
        await dream.create(owner, 'dream', 'create', 'Dream'); await dream.setModelConnection(owner, 'dream', 'default');
        const flow: FlowDraft = {id: 'hotload-flow' as never, name: 'Scan', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]}}}],
            edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [flow]});
        const target = (await dream.scannerTargets(owner, 'dream')).find(item => item.target.id === flow.id)!.target;
        const source = await dream.addFile(owner, 'dream', 'add', 1, {projectId: owner, connectionId: 'dream-local', path: '/notes/source.md',
            executor: {target}, maxOutputTokens: 256, runTokenLimit: 1000});
        await dream.run({ownerProjectId: owner, dreamId: 'dream', sourceId: source.sourceId, operationId: 'scan'});
        let config = await dream.configureConsolidation(owner, 'dream', 'default', source.config.revision, {target});
        const fs = await runtime.vfs.openFileSystem('/'), evidence = (dream as any).evidence;
        const memory = new MemoryCommitStore(operation => fs.meta.seq!.transaction!(operation), evidence.consolidationPath(owner, 'dream'));
        const topics = Array.from({length: 8}, (_, i) => ({id: `rule${i}`, content: `Rule ${i}: ` + 'x'.repeat(240),
            kind: 'constraint' as const, priority: i, updatedAt: i}));
        await memory.stage({version: 'v1', parentVersion: null, requiredScopes: [source.sourceId], topics: [...topics,
            {id: 'legacy', content: 'Legacy rule'}, {id: 'topic', content: 'Complete topic body', kind: 'topic', priority: 999, updatedAt: 50, title: 'Design'}]});
        await memory.commit('commit', 'v1', null, async () => {});
        const session = await runtime.sessionRepository.createSession('Fixture', project.path);
        const bytes = (rows: Awaited<ReturnType<typeof dream.retrieveSessionMemory>>) => rows.reduce((sum, row) => sum
            + new TextEncoder().encode(`Memory (${row.namespaceId}/${row.entryId}):\n${row.content}`).byteLength, 0);
        const standard = await dream.retrieveSessionMemory(session, 20);
        expect(bytes(standard)).toBeLessThanOrEqual(1500); expect(standard[0].entryId).toBe('rule7');
        expect(standard.at(-1)?.entryId).toBe('retrieval-hint');
        expect(await dream.retrieveSessionMemory(session, 20)).toEqual(standard);
        expect(bytes(await dream.retrieveSessionMemory(session, 20, 100))).toBeLessThanOrEqual(100);
        config = await dream.configureConsolidation(owner, 'dream', 'low', config.revision, {target, hotLoadTokens: 500});
        const low = await dream.retrieveSessionMemory(session, 20); expect(bytes(low)).toBeLessThanOrEqual(500);
        config = await dream.configureConsolidation(owner, 'dream', 'high', config.revision, {target, hotLoadTokens: 5000});
        const high = await dream.retrieveSessionMemory(session, 20); expect(bytes(high)).toBeLessThanOrEqual(3000);
        expect(high.length).toBeGreaterThan(standard.length);
        const pointer = high.find(item => item.entryId === 'topic');
        expect(pointer?.content).toContain('Design'); expect(pointer?.content).toContain('dream_read');
        expect(pointer?.content).not.toContain('Complete topic body');
        expect((await dream.searchSessionMemory(session, '', 'topic', `dream:${owner}:dream`))[0].content).toBe('Complete topic body');
        expect((await dream.searchSessionMemory(session, 'design')).map(item => item.entryId)).toContain('topic');
        const access = runtime.projects.workspaceAccess.bind(runtime.projects);
        const revoke = vi.spyOn(runtime.projects, 'workspaceAccess').mockImplementation(item => item.project.id === owner ? 'ro' : access(item));
        expect(await dream.retrieveSessionMemory(session, 20)).toEqual([]); revoke.mockRestore();
    } finally {vi.restoreAllMocks(); await runtime.dispose();}
}, 120000);

import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {ConsolidationStore} from '@nestos/dream/vfs';
import {sha256HexSync} from '@nestos/common';

it('retries a failed scanner through the host using its captured text', async () => {
    const backend = new MemoryBackend(); await backend.init();
    const close = backend.close.bind(backend); backend.close = async () => {};
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    let fail = true, blockGap = false;
    const fetch = vi.fn(async (_url: unknown, options: any) => {
        const request = JSON.parse(options.body);
        const isConsolidation = options.body.includes('project memory consolidation analyzer');
        const content = isConsolidation ? JSON.stringify({proposals: options.body.includes('gap-v13') ? [] : [{id: 'gap-proposal', targetId: 'gap-memory', status: 'ready',
            affectedMemoryIds: ['gap-memory'], changes: [{id: 'gap-memory', content: 'Uses TypeScript'}]}]}) : fail || blockGap && options.body.includes('gap-v12')
            ? 'invalid scanner output' : JSON.stringify({candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]});
        const usage = {prompt_tokens: 50, completion_tokens: 50, total_tokens: 100};
        return request.stream ? new Response(`data: ${JSON.stringify({id: 'response', choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: 'stop'}], usage})}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}})
            : new Response(JSON.stringify({id: 'response', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage}), {headers: {'content-type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetch);
    const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    const runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
    try {
        const project = await runtime.projects.create('Owner');
        let files = await runtime.projects.openFiles(project.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'}); await files.dispose();
        const dream = runtime.dream!;
        await dream.create(project.project.id, 'dream', 'create', 'Dream');
        await dream.setModelConnection(project.project.id, 'dream', 'default');
        const scanner: FlowDraft = {id: 'retry-scan' as never, name: 'Scan', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'agent' as never, name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
                config: {connectionId: 'default', instruction: '${input.prompt}', stream: false, approval: 'none', toolIds: [], skillIds: []}}],
            edges: [], outputs: {result: {value: '${nodes.agent.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [scanner]});
        const target = (await dream.scannerTargets(project.project.id, 'dream')).find(item => item.target.id === scanner.id)!.target;
        const configured = await dream.addFile(project.project.id, 'dream', 'add', 1, {projectId: project.project.id,
            connectionId: 'dream-local', path: '/notes/source.md', executor: {target}, maxOutputTokens: 4096, runTokenLimit: 20000});
        const input = {ownerProjectId: project.project.id, dreamId: 'dream', sourceId: configured.sourceId, operationId: 'retry'};
        await expect(dream.run(input)).rejects.toThrow();
        expect(fetch).toHaveBeenCalled();
        const authorization = (dream as any).sourceAuthorization;
        const authorize = authorization.authorizeDreamSource.bind(authorization);
        const denied = vi.spyOn(authorization, 'authorizeDreamSource').mockRejectedValue(new Error('revoked'));
        const beforeDenied = fetch.mock.calls.length;
        await expect(dream.run(input)).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(beforeDenied);
        denied.mockImplementation(authorize);
        files = await runtime.projects.openFiles(project.path);
        await files.fs.driver.writeContent('/notes/source.md', 'Changed after capture.'); await files.dispose();
        fail = false;
        await dream.run(input);
        const receipt = await dream.readRun(project.project.id, 'dream', 'retry');
        expect(receipt?.execution?.taskId).toBeTruthy();
        expect(await (dream as any).evidence.scanAttempt(project.project.id, 'dream', 'retry')).toMatchObject({attempt: 1, runId: receipt?.execution?.scanRunId});
        expect(receipt?.findings.some(item => item.quote === 'TypeScript is used.')).toBe(true);
        expect(JSON.stringify(fetch.mock.calls.at(-1)?.[1].body)).toContain('TypeScript is used.');
        const count = fetch.mock.calls.length;
        await dream.run(input); expect(fetch).toHaveBeenCalledTimes(count);
        files = await runtime.projects.openFiles(project.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'gap.md', content: 'TypeScript is used. gap-v12'});
        await files.fs.driver.createFile({parentPath: '/notes', name: 'other.md', content: 'TypeScript is used. other'});
        await files.dispose();
        const consolidate: FlowDraft = {id: 'gap-consolidate' as never, name: 'Consolidate', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'agent' as never, name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
                config: {connectionId: 'default', instruction: '${input.prompt}', stream: false, approval: 'none', toolIds: [], skillIds: []}}],
            edges: [], outputs: {result: {value: '${nodes.agent.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [consolidate]});
        const gap = await dream.addFile(project.project.id, 'dream', 'add-gap', configured.config.revision, {projectId: project.project.id,
            connectionId: 'dream-local', path: '/notes/gap.md', executor: {target}, maxOutputTokens: 4096, runTokenLimit: 20000});
        const other = await dream.addFile(project.project.id, 'dream', 'add-other', gap.config.revision, {projectId: project.project.id,
            connectionId: 'dream-local', path: '/notes/other.md', executor: {target}, maxOutputTokens: 4096, runTokenLimit: 20000});
        const consolidationTarget = (await dream.scannerTargets(project.project.id, 'dream')).find(item => item.target.id === consolidate.id)!.target;
        const config = await dream.configureConsolidation(project.project.id, 'dream', 'consolidation', other.config.revision, {target: consolidationTarget});
        const ledger = (dream as any).evidence, tuple: [string, string, string] = [project.project.id, 'file', gap.sourceId];
        const fs = await runtime.vfs.openFileSystem('/');
        const captured = new ConsolidationStore(operation => fs.meta.seq!.transaction!(operation), ledger.consolidationPath(project.project.id, 'dream'));
        const authority = await (dream as any).sourceAuthorization.authorizeDreamSource(project.project.id, 'dream-local', 'fileRead');
        for (let n = 1; n <= 11; n++) {
            const text = `seed-${n}`, previous = n === 1 ? null : `seed-${n - 1}`, next = `seed-${n}`;
            await captured.capture({id: `seed-${n}`, projectId: project.project.id, sourceType: 'file', sourceId: gap.sourceId,
                connectionId: 'dream-local', authority, fingerprint: sha256HexSync(text), locator: `project://${project.project.id}/notes/gap.md`,
                granularity: 'excerpt', snapshot: text, sourceVersion: next, startCursor: previous, endCursor: next, scanned: 1}, previous, next, `seed-${n}`);
            await captured.complete(project.project.id, tuple, n, 0, 'consolidated_no_op', `seed-complete-${n}`);
        }
        blockGap = true;
        expect((await dream.runAll(project.project.id, 'dream', 'batch12', config.revision, [gap.sourceId])).results[0].status).toBe('failed');
        for (const version of [13, 14]) {
            files = await runtime.projects.openFiles(project.path);
            await files.fs.driver.writeContent('/notes/gap.md', `TypeScript is used. gap-v${version}`); await files.dispose();
            const batchResult = (await dream.runAll(project.project.id, 'dream', `batch${version}`, config.revision, [gap.sourceId])).results[0];
            expect(batchResult.status, JSON.stringify(batchResult)).toBe('settled');
        }
        expect((await captured.receipt(project.project.id, tuple, 13))?.status).toBe('consolidated_no_op');
        expect((await captured.receipt(project.project.id, tuple, 14))?.status).toBe('consolidated_proposed');
        expect(await ledger.consolidationWatermark(project.project.id, 'dream', project.project.id, tuple)).toBe(11);
        blockGap = false;
        const beforeGapRetry = fetch.mock.calls.length;
        await dream.runAll(project.project.id, 'dream', 'batch-retry', config.revision, [gap.sourceId]);
        const retryCalls = fetch.mock.calls.slice(beforeGapRetry);
        expect(retryCalls.filter(call => !call[1].body.includes('project memory consolidation analyzer'))).toHaveLength(1);
        expect(await ledger.consolidationWatermark(project.project.id, 'dream', project.project.id, tuple)).toBe(14);
        const pending = (await dream.pendingConsolidation(project.project.id, 'dream', project.project.id)).items;
        expect(pending).toHaveLength(1);
        const afterGapRetry = fetch.mock.calls.length;
        await dream.runAll(project.project.id, 'dream', 'batch-retry', config.revision, [gap.sourceId]);
        expect(fetch).toHaveBeenCalledTimes(afterGapRetry);
        expect((await dream.pendingConsolidation(project.project.id, 'dream', project.project.id)).items).toEqual(pending);
        expect(await ledger.consolidationWatermark(project.project.id, 'dream', project.project.id, tuple)).toBe(14);
        expect(await ledger.watermark(project.project.id, 'dream', other.sourceId)).toBeNull();
        expect(await ledger.consolidationWatermark(project.project.id, 'dream', project.project.id, [project.project.id, 'file', other.sourceId])).toBe(0);
    } finally {await runtime.dispose(); await close(); vi.unstubAllGlobals();}
}, 180000);

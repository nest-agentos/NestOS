import {expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {FlowLibraryCommand} from '@nestos/app-contracts';
import type {FlowDraft} from '@nestos/llm-flow/contracts';
import {createApplicationRuntime} from '../src/runtime/create-application-runtime';
import {dreamScheduleEffect} from '../src/dream/schedule-effect';
import {sha256HexSync} from '@nestos/common';
import {DREAM_OUTBOX_INDEX} from '../src/dream/evidence-store';
import {DreamRecompute} from '../src/dream/recompute';
import {DreamOutbox} from '../src/dream/outbox';
import {DreamDownstream} from '../src/dream/downstream';

it('runs a configured source through the durable consolidation Flow and exposes an authorized pending proposal', async () => {
    const backend = new MemoryBackend(); await backend.init();
    const closeBackend = backend.close.bind(backend); backend.close = async () => {};
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.providers', '/etc/llm/.connections']) await backend.mkdir(path);
    const write = (path: string, value: unknown) => backend.write(path, new TextEncoder().encode(JSON.stringify(value)));
    await write('/etc/llm/.providers/mock.json', {id: 'mock', name: 'Mock', implementation: 'openai-compatible', apiKey: 'fixture', baseURL: 'https://fixture.invalid', models: [{id: 'model', name: 'Mock'}]});
    await write('/etc/llm/.connections/default.json', {id: 'default', name: 'Default', providerId: 'mock', protocol: 'openai-chat', tiers: {optimal: 'model'}});
    await write('/etc/llm/.connection-settings.json', {defaultConnectionId: 'default'});
    const proposal = {proposals: [{id: 'proposal1', targetId: 'memory1', status: 'ready', affectedMemoryIds: ['memory1'],
        changes: [{id: 'memory1', content: 'TypeScript is used.'}]}]};
    let revokeOnModel = false, revoked = false, revokedSource = '';
    const fetch = vi.fn(async (_url: unknown, options: any) => {
        if (revokeOnModel) revoked = true;
        const request = JSON.parse(options.body), content = JSON.stringify(proposal), usage = {prompt_tokens: 50, completion_tokens: 50, total_tokens: 100};
        return request.stream ? new Response(`data: ${JSON.stringify({id: 'response', choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: 'stop'}], usage})}\n\ndata: [DONE]\n\n`, {headers: {'content-type': 'text/event-stream'}})
            : new Response(JSON.stringify({id: 'response', choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage}), {headers: {'content-type': 'application/json'}});
    });
    vi.stubGlobal('fetch', fetch);
    const remoteSourceProvider = {setCredential() {}, async dispose() {}, async open() {throw new Error('unexpected remote file open');}};
    let runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
    try {
        const owner = await runtime.projects.create('Owner'), source = owner;
        const files = await runtime.projects.openFiles(source.path);
        await files.fs.driver.createFile({parentPath: '/notes', name: 'source.md', recursive: true, content: 'TypeScript is used.'});
        await files.fs.driver.createFile({parentPath: '/notes', name: 'second.md', recursive: true, content: 'TypeScript is used.'});
        await files.dispose();
        let dream = runtime.dream!;
        await dream.create(owner.project.id, 'dream', 'create', 'Dream');
        await dream.setModelConnection(owner.project.id, 'dream', 'default');
        const scanner: FlowDraft = {id: 'scan-flow' as never, name: 'Scan', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'result' as never, name: 'Result', plugin: 'builtin.transform', pluginVersion: '1.0.0', inputs: {},
                config: {value: {candidates: [{content: 'Uses TypeScript', kind: 'fact', subject: 'self', project: '', eventTime: '', quote: 'TypeScript is used.'}]}}}],
            edges: [], outputs: {result: {value: '${nodes.result.outputs.result}'}}};
        const consolidate: FlowDraft = {id: 'consolidate-flow' as never, name: 'Consolidate', draftVersion: 1, updatedAt: 0, layout: {},
            parameters: [{name: 'text', type: 'string', required: true, role: 'input', inputSource: 'composer.text'}],
            nodes: [{id: 'agent' as never, name: 'Agent', plugin: 'builtin.agent', pluginVersion: '1.0.0', inputs: {},
                config: {connectionId: 'default', instruction: '${input.prompt}', stream: false, approval: 'none', toolIds: [], skillIds: []}}],
            edges: [], outputs: {result: {value: '${nodes.agent.outputs.result}'}}};
        await runtime.commandBus.execute(FlowLibraryCommand.Restore, {templates: [scanner, consolidate]});
        const targets = await dream.scannerTargets(owner.project.id, 'dream');
        const scanTarget = targets.find(item => item.target.id === scanner.id)!.target;
        const target = targets.find(item => item.target.id === consolidate.id)!.target;
        const sourceConfig = await dream.addFile(owner.project.id, 'dream', 'add', 1, {projectId: source.project.id,
            connectionId: 'dream-local', path: '/notes/source.md', executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        const secondConfig = await dream.addFile(owner.project.id, 'dream', 'add-second', sourceConfig.config.revision, {projectId: source.project.id,
            connectionId: 'dream-local', path: '/notes/second.md', executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        const config = await dream.configureConsolidation(owner.project.id, 'dream', 'configure', secondConfig.config.revision, {target, hotLoadTokens: 5000});
        const result = await dream.runAll(owner.project.id, 'dream', 'batch', config.revision);
        expect(result.results).toMatchObject([{sourceId: sourceConfig.sourceId, status: 'settled'}, {sourceId: secondConfig.sourceId, status: 'settled'}]);
        const pending = await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id);
        expect(pending.items).toMatchObject([{id: 'proposal1', requiredScopes: [sourceConfig.sourceId, secondConfig.sourceId].sort(), changes: [{content: 'TypeScript is used.'}]}]);
        expect(pending.items[0].evidenceIds).toHaveLength(2);
        const firstEvidence = pending.items[0].evidenceIds[0];
        expect(await dream.readProposalEvidence(owner.project.id, 'dream', 'proposal1', firstEvidence))
            .toMatchObject({sourceId: sourceConfig.sourceId, snapshot: 'TypeScript is used.'});
        expect(fetch).toHaveBeenCalledTimes(1);
        for (const id of pending.items[0].evidenceIds) expect(fetch.mock.calls[0][1].body).toContain(id);
        await dream.runAll(owner.project.id, 'dream', 'batch', config.revision);
        expect(fetch).toHaveBeenCalledTimes(1);
        const directFile = await runtime.projects.openFiles(source.path);
        await directFile.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Direct.');
        await directFile.dispose();
        await dream.run({ownerProjectId: owner.project.id, dreamId: 'dream', sourceId: sourceConfig.sourceId, operationId: 'direct'});
        expect((await dream.readProposalEvidence(owner.project.id, 'dream', 'proposal1', firstEvidence)).snapshot).toBe('TypeScript is used.');
        expect(fetch).toHaveBeenCalledTimes(2);
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0].revision).toBe(2);
        const scheduledFile = await runtime.projects.openFiles(source.path);
        await scheduledFile.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Scheduled.');
        await scheduledFile.dispose();
        const effect = dreamScheduleEffect(dream, async () => {}, async () => {});
        const scheduled = await effect.execute({owner: owner.project.id, dream: 'dream', configRevision: config.revision,
            operationId: 'scheduled', scheduledAt: 1, nextAt: 2}, {abortSignal: new AbortController().signal} as never);
        expect(scheduled.results[0].status).toBe('settled');
        expect(fetch).toHaveBeenCalledTimes(3);
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0].revision).toBe(3);
        const installSourceAuthorization = () => {
            const authorizeSource = (dream as any).authorizeConsolidationSource.bind(dream);
            vi.spyOn(dream as any, 'authorizeConsolidationSource').mockImplementation((...args: unknown[]) => {
                if (revoked || revokedSource && [sourceConfig.sourceId, secondConfig.sourceId].includes(args[3] as string))
                    throw new Error('DREAM_AUTHORIZATION_CHANGED');
                return authorizeSource(...args);
            });
        };
        installSourceAuthorization();
        const changed = await runtime.projects.openFiles(source.path);
        await changed.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Updated.');
        await changed.dispose();
        revokeOnModel = true;
        const denied = await dream.runAll(owner.project.id, 'dream', 'after-change', config.revision);
        expect(denied.results[0].status).toBe('failed');
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items).toEqual([]);
        await expect(dream.readProposalEvidence(owner.project.id, 'dream', 'proposal1', firstEvidence)).rejects.toThrow();
        revoked = false;
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0].revision).toBe(3);
        expect(await dream.activeConsolidation(owner.project.id, 'dream')).toBeNull();
        await expect(dream.commitConsolidation(owner.project.id, 'dream', 'stale-review', null, [{id: 'proposal1', revision: 2}]))
            .rejects.toMatchObject({message: 'DREAM_SELECTION_CONFLICT', field: 'proposal1'});
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0].revision).toBe(3);
        const receipt = await dream.commitConsolidation(owner.project.id, 'dream', 'review', null, [{id: 'proposal1', revision: 3}]);
        const outboxFs = await runtime.vfs.openFileSystem('/');
        const outbox = new DreamOutbox(outboxFs, new DreamDownstream(outboxFs, (project, id, scopes) => dream.authorizeDownstream(project, id, scopes)));
        await outbox.scan(); await outbox.quiesce();
        const daily = await dream.readDownstream(owner.project.id, 'dream', 'daily', 'review');
        expect(daily?.changes[0]).toMatchObject({id: 'memory1', action: 'add', content: 'TypeScript is used.'});
        expect(daily?.changes[0].evidenceIds.length).toBeGreaterThan(0);
        expect((await dream.listDownstream(owner.project.id, 'dream', 'kanban')).items).toContainEqual(daily);
        revoked = true;
        expect((await dream.listDownstream(owner.project.id, 'dream', 'kanban')).items).toEqual([]);
        await expect(dream.readDownstream(owner.project.id, 'dream', 'daily', 'review')).rejects.toThrow();
        revoked = false;
        expect((await dream.activeConsolidation(owner.project.id, 'dream'))?.topics).toMatchObject([{id: 'memory1', content: 'TypeScript is used.', kind: 'constraint', priority: 0}]);
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items).toEqual([]);
        expect(await dream.commitConsolidation(owner.project.id, 'dream', 'review', null, [{id: 'proposal1', revision: 3}])).toEqual(receipt);
        const oldSession = await runtime.sessionRepository.createSession('Old version', owner.path);
        expect((await dream.retrieveSessionMemory(oldSession, 10)).map(item => item.content)).toEqual(['TypeScript is used.']);
        revoked = true;
        await expect(dream.commitConsolidation(owner.project.id, 'dream', 'review', null, [{id: 'proposal1', revision: 3}])).rejects.toThrow();
        revoked = false;
        revokeOnModel = false;
        const revised = 'TypeScript is required. '.repeat(80);
        proposal.proposals[0] = {id: 'proposal-update', targetId: 'memory1', status: 'ready', affectedMemoryIds: ['memory1'],
            changes: [{id: 'memory1', content: revised}]};
        const updateFile = await runtime.projects.openFiles(source.path);
        await updateFile.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. New rule.');
        await updateFile.dispose();
        await dream.run({ownerProjectId: owner.project.id, dreamId: 'dream', sourceId: sourceConfig.sourceId, operationId: 'update'});
        const before = await runtime.sessionRepository.createSession('Pending version', owner.path);
        expect((await dream.retrieveSessionMemory(before, 10)).map(item => item.content)).toEqual(['TypeScript is used.']);
        const update = (await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0];
        const updated = await dream.commitConsolidation(owner.project.id, 'dream', 'review-update', receipt.version, [{id: update.id, revision: update.revision}]);
        const after = await runtime.sessionRepository.createSession('Committed version', owner.path);
        expect((await dream.retrieveSessionMemory(after, 10)).map(item => item.content)).toEqual([revised]);
        const bytes = new TextEncoder().encode(`Memory (dream:${owner.project.id}:dream/memory1):\n${revised}`).byteLength;
        expect((await dream.retrieveSessionMemory(after, 10, bytes - 1)).map(item => item.entryId)).toEqual(['retrieval-hint']);
        expect(await dream.retrieveSessionMemory(after, 10, bytes)).toHaveLength(1);
        expect(await dream.searchSessionMemory(after, 'required')).toMatchObject([{entryId: 'memory1', content: revised}]);
        expect(await dream.searchSessionMemory(after, '', 'memory1', `dream:${owner.project.id}:dream`)).toHaveLength(1);
        expect(await dream.searchSessionMemory(after, '', 'memory1', 'dream:other:dream')).toEqual([]);
        expect(await dream.retrieveSessionMemory(after, 10, 1)).toEqual([]);
        revoked = true;
        expect(await dream.retrieveSessionMemory(after, 10)).toEqual([]);
        expect(await dream.searchSessionMemory(after, 'required')).toEqual([]);
        revoked = false;
        proposal.proposals[0] = {id: 'proposal2', targetId: 'memory2', status: 'conflict', affectedMemoryIds: ['memory2'],
            changes: [{id: 'memory2', content: 'A conflicting rule.'}]};
        const conflictFile = await runtime.projects.openFiles(source.path);
        await conflictFile.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Conflict.');
        await conflictFile.dispose();
        await dream.run({ownerProjectId: owner.project.id, dreamId: 'dream', sourceId: sourceConfig.sourceId, operationId: 'conflict'});
        const conflict = (await dream.pendingConsolidation(owner.project.id, 'dream', source.project.id)).items[0];
        expect(conflict.status).toBe('conflict');
        const resolution = {action: 'choose' as const, evidenceId: conflict.evidenceIds[0]};
        const resolved = await dream.resolveConsolidation(owner.project.id, 'dream', 'resolve', conflict.id, conflict.revision, resolution);
        expect(resolved).toMatchObject({status: 'ready', revision: 2});
        expect(await dream.resolveConsolidation(owner.project.id, 'dream', 'resolve', conflict.id, conflict.revision, resolution)).toEqual(resolved);
        await expect(dream.resolveConsolidation(owner.project.id, 'dream', 'resolve', conflict.id, conflict.revision, {action: 'reject'}))
            .rejects.toThrow('DREAM_OPERATION_CONFLICT');
        const conflictCommit = await dream.commitConsolidation(owner.project.id, 'dream', 'review-conflict', updated.version, [{id: conflict.id, revision: resolved.revision}]);
        expect((await dream.activeConsolidation(owner.project.id, 'dream'))?.topics).toHaveLength(2);
        const watermarkBeforeRollback = await dream.evidence.watermark(owner.project.id, 'dream', sourceConfig.sourceId);
        const system = await runtime.vfs.openFileSystem('/'), ledger = dream.evidence.consolidationPath(owner.project.id, 'dream');
        const eventsBeforeRollback = Number(await system.meta.seq!.getEntry(ledger, 'outbox-count'));
        const rollback = await dream.rollbackConsolidation(owner.project.id, 'dream', 'rollback', 'review', conflictCommit.version);
        expect(await dream.evidence.watermark(owner.project.id, 'dream', sourceConfig.sourceId)).toEqual(watermarkBeforeRollback);
        expect(Number(await system.meta.seq!.getEntry(ledger, 'outbox-count'))).toBe(eventsBeforeRollback + 1);
        expect((await dream.activeConsolidation(owner.project.id, 'dream'))?.topics).toMatchObject([{id: 'memory1', content: 'TypeScript is used.', kind: 'constraint', priority: 0}]);
        expect(await dream.rollbackConsolidation(owner.project.id, 'dream', 'rollback', 'review', conflictCommit.version)).toEqual(rollback);
        expect(Number(await system.meta.seq!.getEntry(ledger, 'outbox-count'))).toBe(eventsBeforeRollback + 1);
        const rollbackOutbox = new DreamOutbox(system, new DreamDownstream(system, (project, id, scopes) => dream.authorizeDownstream(project, id, scopes)));
        await rollbackOutbox.scan(); await rollbackOutbox.quiesce();
        const rollbackContribution = await dream.readDownstream(owner.project.id, 'dream', 'daily', 'rollback');
        expect(rollbackContribution?.referenceCommits).toEqual(['review']);
        expect(rollbackContribution?.changes.find(change => change.id === 'memory1')?.evidenceIds).toContain(firstEvidence);
        const rollbackRef = rollbackContribution?.changes.find(change => change.id === 'memory1')?.evidenceRefs?.find(ref => ref.evidenceId === firstEvidence);
        expect(rollbackRef).toBeTruthy();
        expect((await dream.readProposalEvidence(owner.project.id, 'dream', rollbackRef!.proposalId, rollbackRef!.evidenceId)).snapshot).toBe('TypeScript is used.');
        expect((await dream.readCommittedVersion(owner.project.id, 'dream', 'review'))?.candidate.topics).toMatchObject([{id: 'memory1', content: 'TypeScript is used.', kind: 'constraint', priority: 0}]);
        await expect(dream.rollbackConsolidation(owner.project.id, 'dream', 'rollback-stale', 'review-update', conflictCommit.version))
            .rejects.toThrow('DREAM_VERSION_CONFLICT');
        revoked = true;
        await expect(dream.readCommittedVersion(owner.project.id, 'dream', 'review')).rejects.toThrow();
        await expect(dream.rollbackConsolidation(owner.project.id, 'dream', 'rollback', 'review', conflictCommit.version)).rejects.toThrow();
        await expect(dream.rollbackConsolidation(owner.project.id, 'dream', 'rollback-denied', 'review-update', rollback.version)).rejects.toThrow();
        revoked = false;
        expect((await dream.activeConsolidation(owner.project.id, 'dream'))?.version).toBe(rollback.version);
        const other = await runtime.projects.create('Other');
        const otherFiles = await runtime.projects.openFiles(other.path);
        await otherFiles.fs.driver.createFile({parentPath: '/notes', name: 'other.md', recursive: true, content: 'TypeScript is used.'});
        await otherFiles.dispose();
        const otherConfig = await dream.addFile(owner.project.id, 'dream', 'add-other', config.revision, {projectId: other.project.id,
            connectionId: 'dream-local', path: '/notes/other.md', executor: {target: scanTarget}, maxOutputTokens: 256, runTokenLimit: 1000});
        const jointConfig = await dream.configureConsolidation(owner.project.id, 'dream', 'joint-config', otherConfig.config.revision,
            {target, crossProject: true});
        const jointFile = await runtime.projects.openFiles(owner.path);
        await jointFile.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Joint.'); await jointFile.dispose();
        proposal.proposals[0] = {id: 'joint-proposal', targetId: 'joint-memory', status: 'ready', affectedMemoryIds: ['joint-memory'],
            changes: [{id: 'joint-memory', content: 'Joint result.'}]};
        const joint = await dream.runAll(owner.project.id, 'dream', 'joint-run', jointConfig.revision, [sourceConfig.sourceId, otherConfig.sourceId]);
        expect(joint.results.every(item => item.status === 'settled')).toBe(true);
        const jointScope = 'joint-' + sha256HexSync(JSON.stringify([owner.project.id, other.project.id].sort()));
        const jointProposal = (await dream.pendingConsolidation(owner.project.id, 'dream', jointScope)).items[0];
        expect(jointProposal.requiredScopes).toEqual([sourceConfig.sourceId, secondConfig.sourceId, otherConfig.sourceId].sort());
        expect(jointProposal.evidenceIds).toHaveLength(2);
        const jointCommit = await dream.commitConsolidation(owner.project.id, 'dream', 'joint-review', rollback.version,
            [{id: jointProposal.id, revision: jointProposal.revision}]);
        const bSession = await runtime.sessionRepository.createSession('B session', other.path);
        expect(await dream.retrieveSessionMemory(bSession, 10)).toEqual([]);
        expect(await dream.searchSessionMemory(bSession, 'Joint')).toEqual([]);
        proposal.proposals[0] = {id: 'joint-update', targetId: 'joint-memory', status: 'ready', affectedMemoryIds: ['joint-memory'],
            changes: [{id: 'joint-memory', content: 'Joint revised.'}]};
        const duringA = await runtime.projects.openFiles(owner.path);
        await duringA.fs.driver.writeContent('/notes/source.md', 'TypeScript is used. Joint revocation.'); await duringA.dispose();
        const duringB = await runtime.projects.openFiles(other.path);
        await duringB.fs.driver.writeContent('/notes/other.md', 'TypeScript is used. Joint revocation.'); await duringB.dispose();
        revokeOnModel = true;
        const during = await dream.runAll(owner.project.id, 'dream', 'joint-revoke', jointConfig.revision, [sourceConfig.sourceId, otherConfig.sourceId]);
        expect(during.results.every(item => item.status === 'failed')).toBe(true);
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', jointScope)).items).toEqual([]);
        revokeOnModel = false; revoked = false;
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', jointScope)).items).toEqual([]);
        expect((await dream.activeConsolidation(owner.project.id, 'dream'))?.version).toBe(jointCommit.version);
        revokedSource = sourceConfig.sourceId;
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', jointScope)).items).toEqual([]);
        await expect(dream.activeConsolidation(owner.project.id, 'dream')).rejects.toThrow();
        const beforeEvents: string[] = [];
        await system.meta.seq!.walkEntries(DREAM_OUTBOX_INDEX, row => {beforeEvents.push(row.key); return true;}, {keyPrefix: 'recompute-request:'});
        expect(beforeEvents).toEqual([]);
        revokedSource = '';
        proposal.proposals[0] = {id: 'b-proposal', targetId: 'b-memory', status: 'ready', affectedMemoryIds: ['b-memory'],
            changes: [{id: 'b-memory', content: 'B only.'}]};
        let changedIdentity = false;
        const installLiveAuthorization = () => {
            const route = (dream as any).sourceAuthorization, original = route.authorizeDreamSource.bind(route);
            vi.spyOn(route, 'authorizeDreamSource').mockImplementation(async (...args: unknown[]) => {
                const authority = await original(...args);
                return args[0] === other.project.id ? {...authority, revision: authority.revision + '-new',
                    ...(changedIdentity ? {principalId: 'different-principal'} : {})} : authority;
            });
        };
        installLiveAuthorization();
        const drifted = await runtime.projects.openFiles(other.path);
        await drifted.fs.driver.writeContent('/notes/other.md', 'TypeScript is used. Source drifted after capture.'); await drifted.dispose();
        const remote = runtime.projects.remoteMounts as any, listenersBefore = remote.listeners.size;
        runtime.startBackground?.();
        await vi.waitFor(() => expect(remote.listeners.size).toBeGreaterThan(listenersBefore), {timeout: 15000, interval: 100});
        revokedSource = sourceConfig.sourceId;
        for (const listener of [...remote.listeners] as Array<(change?: unknown) => void>) listener();
        await vi.waitFor(async () => expect((await dream.pendingConsolidation(owner.project.id, 'dream', other.project.id)).items
            .some(item => item.id === 'b-proposal')).toBe(true), {timeout: 45000, interval: 100});
        const bProposal = (await dream.pendingConsolidation(owner.project.id, 'dream', other.project.id)).items.find(item => item.id === 'b-proposal')!;
        expect(bProposal.requiredScopes).toEqual([otherConfig.sourceId]);
        changedIdentity = true;
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', other.project.id)).items).toEqual([]);
        changedIdentity = false;
        const bPayload = fetch.mock.calls.at(-1)![1].body;
        expect(bPayload).not.toContain('Joint result.'); expect(bPayload).not.toContain('TypeScript is required.');
        expect(bPayload).toContain('Joint revocation.'); expect(bPayload).not.toContain('Source drifted after capture.');
        const requestRows: Array<{key: string; value: string}> = [];
        await vi.waitFor(async () => {
            requestRows.length = 0;
            await system.meta.seq!.walkEntries(DREAM_OUTBOX_INDEX, row => {requestRows.push(row); return true;}, {keyPrefix: 'recompute-request:'});
            expect(requestRows.some(row => JSON.parse(row.value).plan.project === other.project.id && JSON.parse(row.value).state === 'done')).toBe(true);
        }, {timeout: 15000, interval: 100});
        const beforeRepeat = fetch.mock.calls.length;
        for (const listener of [...remote.listeners] as Array<(change?: unknown) => void>) listener();
        const probe = new DreamRecompute(system, dream); await probe.scan(); await probe.quiesce();
        expect(fetch).toHaveBeenCalledTimes(beforeRepeat);
        await runtime.quiesce();
        const completed = requestRows.find(row => JSON.parse(row.value).plan.project === other.project.id)!;
        const pendingRequest = {...JSON.parse(completed.value), state: 'pending'};
        await system.meta.seq!.transaction!(tx => tx.setEntry(DREAM_OUTBOX_INDEX, completed.key, JSON.stringify(pendingRequest)));
        await runtime.dispose();
        runtime = await createApplicationRuntime({backend, ownerKind: 'cli', startupMode: 'interactive', digitalTwinAutoStart: false, remoteSourceProvider});
        dream = runtime.dream!; installSourceAuthorization(); installLiveAuthorization();
        const reopened = await runtime.vfs.openFileSystem('/'); runtime.startBackground?.();
        await vi.waitFor(async () => expect(JSON.parse((await reopened.meta.seq!.getEntry(DREAM_OUTBOX_INDEX, completed.key))!).state).toBe('done'),
            {timeout: 45000, interval: 100});
        expect(fetch).toHaveBeenCalledTimes(beforeRepeat);
        expect((await dream.pendingConsolidation(owner.project.id, 'dream', other.project.id)).items.filter(item => item.id === 'b-proposal')).toHaveLength(1);
    } finally {await runtime.dispose(); await closeBackend(); vi.unstubAllGlobals(); vi.restoreAllMocks();}
}, 210000);

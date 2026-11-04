import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Kernel } from '@itookit/durable-kernel';
import { SessionMemoryProvider, SharedMemoryStore } from '@itookit/llm-session';
import { openProfileInspectionFs } from '../src/runtime';

async function open(root: string) {
    const host = await openProfileInspectionFs(root);
    const store = new SharedMemoryStore(host.fs); await store.init();
    const kernel = new Kernel({ catalog: { fs: host.fs } });
    kernel.registerStorageResolver({ kind: 'test-session', resolve: async binding => ({ fs: host.fs, rootPath: `/sessions/${binding.locator}/kernel` }) });
    await kernel.initialize();
    return { kernel, store, memory: new SessionMemoryProvider(kernel, store), close: async () => {
        kernel.dispose(); await kernel.waitIdle(); await host.dispose();
    } };
}

function waitMessage(child: ChildProcess): Promise<{ phase: string }> {
    return new Promise((resolve, reject) => {
        let errors = '';
        const timer = setTimeout(() => { cleanup(); reject(new Error(`Shared Memory child timed out: ${errors}`)); }, 15000);
        const stderr = (value: Buffer) => { errors += value.toString(); };
        const cleanup = () => { clearTimeout(timer); child.off('message', receive); child.off('exit', exit); child.stderr?.off('data', stderr); };
        const receive = (message: unknown) => { cleanup(); resolve(message as { phase: string }); };
        const exit = (code: number | null) => { cleanup(); reject(new Error(`Shared Memory child exited ${code}: ${errors}`)); };
        child.on('message', receive); child.on('exit', exit); child.stderr?.on('data', stderr);
    });
}

async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
}

it.each(['data', 'receipt', 'committed'].flatMap(phase => ['write', 'remove', 'prune'].map(action => ({ phase, action }))))
('keeps shared $action data, receipts and audit atomic across SIGKILL at $phase', async ({ phase, action }) => {
    const root = await mkdtemp(join(tmpdir(), 'memory-crash-'));
    let host: Awaited<ReturnType<typeof open>> | undefined, child: ChildProcess | undefined;
    try {
        host = await open(root);
        const ref = await host.store.create('team', 'notes', 'creator');
        await host.store.grant(ref, 'one', { readScopes: ['project'], writeScopes: ['project'] }, ref.revision);
        const policy = { namespaceId: 'notes', sharedMemory: { id: ref.id, incarnation: ref.incarnation }, readScopes: ['project'], writeScopes: ['project'] };
        if (action !== 'write') await host.memory.upsert('one', policy, { scope: 'project', entryId: 'note', content: 'seed' });
        await host.close(); host = undefined;
        child = fork(fileURLToPath(new URL('./fixtures/shared-memory-host.ts', import.meta.url)), [root, ref.incarnation, phase, action],
            { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        expect((await waitMessage(child)).phase).toBe(phase);
        await stop(child); child = undefined;
        host = await open(root);
        const beforeReplay = await host.memory.list('one', policy);
        expect(beforeReplay).toHaveLength(phase === 'committed' ? Number(action === 'write') : Number(action !== 'write'));
        const options = { origin: { operationId: action, taskId: 'task', effectId: action } };
        if (action === 'write') await host.memory.upsert('one', policy, { scope: 'project', entryId: 'note', content: 'written' }, options);
        else if (action === 'remove') await host.memory.remove('one', policy, 'project', 'note', options);
        else expect((await host.memory.prune('one', policy, Number.MAX_SAFE_INTEGER)).removed).toBe(phase === 'committed' ? 0 : 1);
        const afterReplay = await host.memory.list('one', policy);
        expect(afterReplay).toHaveLength(Number(action === 'write'));
        if (phase === 'committed' && action === 'write') expect(afterReplay).toEqual(beforeReplay);
        const audit = (await host.store.history(ref)).filter(event => event.action === 'mutate');
        expect(audit).toHaveLength((action === 'write' ? 0 : 1) + 1 + Number(action === 'prune' && phase === 'committed'));
    } finally { if (child) await stop(child); await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 25000);

it('arbitrates two real Session writers in separate SQLite processes and retains data after creator deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'memory-two-writers-'));
    const children: ChildProcess[] = [];
    let host: Awaited<ReturnType<typeof open>> | undefined;
    try {
        host = await open(root);
        for (const id of ['one', 'two']) await host.kernel.createSession({ id, storage: { kind: 'test-session', locator: id } });
        const ref = await host.store.create('team', 'notes', 'one');
        for (const id of ['one', 'two']) {
            const current = await host.store.inspect(ref);
            await host.store.grant(ref, id, { readScopes: ['project'], writeScopes: ['project'] }, current.revision);
        }
        const policy = { namespaceId: 'notes', sharedMemory: { id: ref.id, incarnation: ref.incarnation }, readScopes: ['project'], writeScopes: ['project'] };
        await host.memory.upsert('one', policy, { scope: 'project', entryId: 'contended', content: 'before' });
        const revision = (await host.memory.list('one', policy))[0].revision;
        await host.close(); host = undefined;
        for (const id of ['one', 'two']) children.push(fork(fileURLToPath(new URL('./fixtures/shared-memory-writer.ts', import.meta.url)),
            [root, ref.incarnation, id, revision], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
        expect(await Promise.all(children.map(waitMessage))).toEqual([{ phase: 'ready' }, { phase: 'ready' }]);
        const results = children.map(waitMessage); children.forEach(child => child.send({ start: true }));
        expect((await Promise.all(results)).map(result => result.phase).sort()).toEqual(['conflict', 'written']);
        await Promise.all(children.map(child => new Promise<void>(resolve => child.exitCode !== null ? resolve() : child.once('exit', () => resolve()))));
        host = await open(root);
        const entries = await host.memory.list('two', policy);
        expect(entries).toHaveLength(1); expect(['one', 'two']).toContain(entries[0].content);
        expect(await host.kernel.removeSession('one')).toBe(true);
        expect(await host.memory.list('two', policy)).toEqual(entries);
        expect((await host.store.history(ref)).filter(event => event.action === 'mutate')).toHaveLength(2);
    } finally { await Promise.all(children.map(stop)); await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 25000);

it.each(['data', 'receipt', 'committed'])('keeps source references and summary receipts atomic across SIGKILL at %s', async phase => {
    const root = await mkdtemp(join(tmpdir(), 'memory-compact-crash-'));
    let host: Awaited<ReturnType<typeof open>> | undefined, child: ChildProcess | undefined;
    try {
        host = await open(root);
        const ref = await host.store.create('team', 'notes', 'creator');
        await host.store.grant(ref, 'one', { readScopes: ['project'], writeScopes: ['project'] }, ref.revision);
        const policy = { namespaceId: 'notes', sharedMemory: { id: ref.id, incarnation: ref.incarnation }, readScopes: ['project'], writeScopes: ['project'] };
        await host.memory.upsert('one', policy, { scope: 'project', entryId: 'source', content: 'Long original text that must always be retained.' });
        const original = (await host.memory.list('one', policy))[0];
        await host.close(); host = undefined;
        child = fork(fileURLToPath(new URL('./fixtures/shared-memory-host.ts', import.meta.url)), [root, ref.incarnation, phase, 'compact'],
            { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        expect((await waitMessage(child)).phase).toBe(phase); await stop(child); child = undefined;
        host = await open(root);
        const before = await host.memory.list('one', policy);
        expect(before).toHaveLength(phase === 'committed' ? 2 : 1);
        expect(before.find(entry => entry.entryId === 'source')).toEqual(original);
        await host.memory.compact('one', policy, { scope: 'project', entryId: 'summary', content: 'short' },
            [{ entryId: original.entryId, revision: original.revision }],
            { origin: { operationId: 'compact', taskId: 'task', effectId: 'compact' }, model: 'test-model' });
        const after = await host.memory.list('one', policy);
        expect(after).toHaveLength(2);
        if (phase === 'committed') expect(after).toEqual(before);
        expect(after.find(entry => entry.entryId === 'summary')?.compression?.sources).toEqual([
            { entryId: original.entryId, revision: original.revision, contentHash: original.contentHash }]);
        expect((await host.store.history(ref)).filter(event => event.action === 'mutate')).toHaveLength(2);
    } finally { if (child) await stop(child); await host?.close(); await rm(root, { recursive: true, force: true }); }
}, 25000);

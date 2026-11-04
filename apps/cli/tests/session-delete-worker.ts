/**
 * Child-process worker for session deletion across a real process restart.
 *
 * `prepare <root> <sessionId>` creates a Session, writes Kernel shared state and
 * then deletes only the Kernel storage tree (an interrupted removal).
 * `finish <root> <sessionId>` opens the same root in a fresh process and must be
 * able to complete the deletion.
 */
import { createVFS } from '@itookit/vfs-core';
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { Kernel } from '@itookit/durable-kernel';
import { SessionDirectoryStorageResolver, SessionRepository, sessionDirectoryStorage } from '@itookit/llm-session';
import { SessionLifecycleService } from '@itookit/app-core';

const [mode, root, sessionId] = process.argv.slice(2);

async function open() {
    const backend = await openLocalFSBackend({ rootDir: `${root}/data`, sidecarDir: `${root}/meta` });
    const { manager } = await createVFS({ rootBackend: backend });
    const fs = await manager.openFileSystem('/');
    const repository = new SessionRepository(fs); await repository.init();
    const kernel = new Kernel({ catalog: { fs, rootPath: '/var/lib/kernel' } });
    kernel.registerStorageResolver(new SessionDirectoryStorageResolver(fs));
    await kernel.initialize();
    return { manager, fs, repository, kernel };
}

if (mode === 'prepare') {
    const { manager, fs, repository, kernel } = await open();
    await repository.ensureSession(sessionId, 'Interrupted');
    await repository.writeDocument(sessionId, 'round-r1.json', JSON.stringify({ id: 'r1', input: [], output: [] }));
    const session = await kernel.createSession({ id: sessionId, storage: sessionDirectoryStorage(sessionId) });
    await session.setShared('stale', 'value');
    await kernel.closeSession(sessionId, true);
    // Interrupted removal: the Kernel storage tree is gone, its records remain.
    await fs.driver.updateMetadata(`/var/lib/sessions/${sessionId}/kernel`, { vfsFixedLayout: false });
    await fs.driver.delete([`/var/lib/sessions/${sessionId}/kernel`], { recursive: true });
    const kernelStorageGone = !await fs.driver.exists(`/var/lib/sessions/${sessionId}/kernel`);
    kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
    process.stdout.write(JSON.stringify({ prepared: true, kernelStorageGone }) + '\n');
} else if (mode === 'finish') {
    const { manager, fs, repository, kernel } = await open();
    const lifecycle = new SessionLifecycleService({ repository, kernel });
    await lifecycle.deleteSession(sessionId);
    const manifest = await repository.getManifest(sessionId).then(() => 'present', error => error.code ?? 'error');
    const ids: string[] = []; for await (const record of kernel.listSessions()) ids.push(record.id);
    const dirGone = !await fs.driver.exists(`/var/lib/sessions/${sessionId}`);
    kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
    process.stdout.write(JSON.stringify({ manifest, ids, dirGone }) + '\n');
} else if (mode === 'reuse') {
    const { manager, repository, kernel } = await open();
    const before = (await kernel.sessionStat(sessionId)).phase;
    const reused = await kernel.createSession({ id: sessionId, storage: sessionDirectoryStorage(sessionId) });
    const after = (await kernel.sessionStat(sessionId)).phase;
    const stale = await reused.getShared('stale');
    kernel.dispose(); await kernel.waitIdle(); await repository.dispose(); await manager.dispose();
    process.stdout.write(JSON.stringify({ before, after, stale: stale ?? null }) + '\n');
} else {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(1);
}

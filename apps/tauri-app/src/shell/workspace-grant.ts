import type { ApplicationPlatformServices } from '@itookit/app-core';

export interface TauriWorkspaceGrant {
    sessionId: string;
    revision: number;
    mountId: string;
    sourceId: string;
    root: string;
    at: string;
    repository: string;
}

/** Freeze the same authorization identity used by file views and native processes. */
export async function resolveTauriWorkspaceGrant(services: ApplicationPlatformServices,
    sessionId: string, rootDir: string): Promise<TauriWorkspaceGrant> {
    const record = await services.sessionFiles.inspect(sessionId);
    const writable = record?.mounts.filter(mount => mount.access === 'rw') ?? [];
    if (record?.state !== 'active' || writable.length !== 1 || writable[0].at !== record.cwd) {
        throw new Error('Worktree requires one writable mount with its root as the working directory');
    }
    const selected = writable[0];
    const native = (await services.directoryMounts.processMounts(sessionId)).filter(mount => mount.at === selected.at);
    if (native.length !== 1 || native[0].sourceId !== selected.sourceId || native[0].access !== 'rw') {
        throw new Error('Workspace process grant does not match the file grant');
    }
    const current = await services.sessionFiles.inspect(sessionId);
    if (current?.state !== 'active' || current.revision !== record.revision) {
        throw new Error('Workspace authorization changed while resolving the repository');
    }
    return { sessionId, revision: record.revision, mountId: selected.mountId, sourceId: selected.sourceId,
        root: selected.root ?? '/', at: selected.at,
        repository: selected.sourceId === 'admin-home' ? rootDir.replace(/\/$/, '') + native[0].directory : native[0].directory };
}

import {createFileSystemView, type IFileSystem} from '@nestos/vfs-core';

/** The returned owner is a private runtime resource and must be disposed by its host. */
export async function openDreamSystemWorkspace(fs: IFileSystem, owner: string, dream: string,
    authorizeOwner: () => Promise<void>): Promise<{fs: IFileSystem; dispose(): Promise<void>}> {
    if (![owner, dream].every(value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)))
        throw new Error('DREAM_INVALID_SCOPE');
    try {await authorizeOwner();} catch {throw new Error('DREAM_OWNER_AUTHORIZATION_FAILED');}
    const root = `/var/lib/projects/${owner}/dream/${dream}`;
    if (!await fs.driver.exists(root)) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
    const view = createFileSystemView({viewId: `dream:${owner}:${dream}`, mounts: [{mountId: 'dream', at: '/', fs, root, access: 'rw'}]});
    return {fs: view, dispose: () => view.dispose()};
}

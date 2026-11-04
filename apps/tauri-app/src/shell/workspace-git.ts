import { invoke } from '@tauri-apps/api/core';

/** One host-selected repository and isolated copy; no arbitrary cwd can enter the Git IPC. */
export class TauriWorkspaceGitRunner {
    private readonly repository: string;
    private readonly workspace: string;
    constructor(repository: string, workspace: string) {
        this.repository = absolutePath(repository);
        this.workspace = absolutePath(workspace);
        if (this.repository === this.workspace) throw new Error('Git workspace must be an isolated directory');
    }

    async run(program: string, args: string[], options: { cwd: string }): Promise<{ stdout: string }> {
        const cwd = absolutePath(options.cwd);
        if (program !== 'git' || ![this.repository, this.workspace].includes(cwd)) throw new Error('Git working directory is outside this workspace lease');
        const mutatesWorktree = args[0] === 'worktree' && ['add', 'remove'].includes(args[1]);
        if (mutatesWorktree && absolutePath(args[1] === 'add' ? args[4] : args[args.length - 1]) !== this.workspace) {
            throw new Error('Git target is outside this workspace lease');
        }
        return withDirectoryGrants(cwd, mutatesWorktree ? this.workspace.slice(0, this.workspace.lastIndexOf('/')) || '/' : undefined,
            async (repositoryId, workspaceId) => {
                const [stdout, stderr, code] = await invoke<[string, string, number]>('git_command', {
                    repositoryId, workspaceId, args, timeoutMs: 30_000,
                });
                if (code !== 0) throw new Error(`Git exited with code ${code}: ${stderr || stdout}`);
                return { stdout };
            });
    }
}

function absolutePath(value: string): string {
    if (typeof value !== 'string' || !value.startsWith('/') || /[\\\0\r\n]/.test(value)
        || value.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid host Git path');
    return value.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

async function withDirectoryGrants<T>(cwd: string, parent: string | undefined,
    action: (repositoryId: string, workspaceId?: string) => Promise<T>): Promise<T> {
    const ids: string[] = [], errors: unknown[] = [];
    let result: T | undefined;
    try {
        ids.push((await invoke<{ id: string }>('directory_open', { path: cwd })).id);
        if (parent) ids.push((await invoke<{ id: string }>('directory_open', { path: parent })).id);
        result = await action(ids[0], ids[1]);
    } catch (error) { errors.push(error); }
    const closed = await Promise.allSettled(ids.map(id => invoke('directory_close', { id })));
    for (const item of closed) if (item.status === 'rejected') errors.push(item.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Git command and directory cleanup failed');
    return result!;
}

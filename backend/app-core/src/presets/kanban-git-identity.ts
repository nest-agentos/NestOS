import type {RemoteProcessHandle} from '../projects/remote-mounts';
import {gitWorkspace} from '../projects/worktree-modules';
import {failure} from '../run/prompt-bundle';

export interface GitCommitIdentity {name: string; email: string}
/** Resolve configured project authority before entering the isolated native Session. */
export async function readGitCommitIdentity(process: RemoteProcessHandle): Promise<GitCommitIdentity> {
    const result = await gitWorkspace(process, '/workspace', ['-c', 'user.useConfigOnly=true', 'var', 'GIT_AUTHOR_IDENT'], true);
    const match = /^([^<>\r\n]+) <([^<>\r\n]+)> \d+ [+-]\d{4}\s*$/.exec(result.stdout);
    if (result.code !== 0 || !match || !match[1].trim() || match[1].length > 256 || match[2].length > 320)
        throw failure('GIT_COMMIT_IDENTITY_REQUIRED');
    return {name: match[1], email: match[2]};
}

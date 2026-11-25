import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {ProjectRemoteMountService, RemoteFileSourceProvider, RemoteProcessHandle} from '../projects/remote-mounts';
import type {ChangeSnapshot, DreamChangeSource} from './change-source';

const log = createModuleLogger('dream-git-history');

export async function readDreamGitHistory(remote: ProjectRemoteMountService, provider: RemoteFileSourceProvider,
    source: DreamChangeSource): Promise<ChangeSnapshot> {
    const started = Date.now(), operationId = source.id;
    let stage = 'binding';
    try {
        const process = await acquireReadOnlyGit(remote, provider, source);
        try {
            stage = 'history';
            const {stdout, code} = await process.nativeShell.exec('git', gitLogArguments(source), {cwd: '/workspace', timeoutMs: 5000});
            if (code !== 0) throw new Error('DREAM_GIT_LOG_FAILED');
            const snapshot = commitSnapshot(stdout, source.maxEntries);
            log.info('dream.git.read', {operationId, stage, result: 'success', count: snapshot.scanned, durationMs: Date.now() - started});
            return snapshot;
        } finally {await process.release();}
    } catch (error) {
        const code = error instanceof Error && /^DREAM_GIT_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_GIT_READ_FAILED';
        log.warn('dream.git.read', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}

async function acquireReadOnlyGit(remote: ProjectRemoteMountService, provider: RemoteFileSourceProvider,
    source: DreamChangeSource): Promise<RemoteProcessHandle> {
    const root = remote.list(source.projectId).find(mount => mount.at === '/');
    if (!root?.serverProjectId || root.connectionId !== source.connectionId || !provider.projects || !provider.projectProcess)
        throw new Error('DREAM_GIT_UNAVAILABLE');
    const connection = await remote.resolveConnection(source.connectionId, {timeoutMs: 5000});
    const client = provider.projects(connection);
    const project = await client.read(root.serverProjectId, {timeoutMs: 5000}).finally(() => client.close());
    const caps = await remote.executionCapabilities(source.connectionId, {timeoutMs: 5000});
    if (project.id !== root.serverProjectId || project.revision !== root.serverProjectRevision || caps.serverId !== root.serverId)
        throw new Error('DREAM_GIT_BINDING_CHANGED');
    if (project.mounts.length || !caps.serverId || !caps.process.exec || !caps.processEpoch || caps.pathModel !== 'virtual-root'
        || caps.executionModel !== 'sandbox' || caps.workspaceConsistency !== 'isolated' || caps.readOnlyEnforcement !== 'kernel-enforced')
        throw new Error('DREAM_GIT_UNAVAILABLE');
    return provider.projectProcess(connection, project, {serverId: caps.serverId, epoch: caps.processEpoch, cwd: '/workspace',
        mounts: [{alias: project.alias, path: project.path, at: '/workspace', access: 'ro'}]});
}

export function gitLogArguments(source: Pick<DreamChangeSource, 'directory' | 'exclude' | 'maxEntries'>): string[] {
    const includes = source.directory === '/' ? [] : [':(top,literal)' + source.directory.slice(1)];
    const excludes = source.exclude.map(path => ':(top,exclude,literal)' + path.slice(1));
    return ['--no-pager', '-c', 'log.showSignature=false', 'log', '-z', '--format=%H%x00%ct%x00%s',
        '--no-show-signature', '--no-ext-diff', '--no-textconv', '-n', String(source.maxEntries), 'HEAD', '--', ...includes, ...excludes];
}

function commitSnapshot(stdout: string, limit: number): ChangeSnapshot {
    if (new TextEncoder().encode(stdout).length > 32768) throw new Error('DREAM_GIT_LIMIT');
    const fields = stdout ? stdout.split('\0') : [];
    if (fields.at(-1) === '') fields.pop();
    if (fields.length % 3 !== 0 || fields.length / 3 > limit) throw new Error('DREAM_GIT_RESULT_INVALID');
    const commits = [];
    for (let index = 0; index < fields.length; index += 3) {
        const [commit, timestamp, subject] = fields.slice(index, index + 3);
        if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(commit) || !/^\d{1,12}$/.test(timestamp)) throw new Error('DREAM_GIT_RESULT_INVALID');
        commits.push({commit, time: Number(timestamp), subject});
    }
    const text = JSON.stringify(commits);
    if (new TextEncoder().encode(text).length > 32768) throw new Error('DREAM_GIT_LIMIT');
    return {text, hash: sha256HexSync(text), scanned: commits.length, directories: 0};
}

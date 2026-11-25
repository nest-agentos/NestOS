import {expect, it, vi} from 'vitest';
import {readDreamGitHistory} from '../src/dream/git-history';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../src/projects/remote-mounts';

it('reads bounded commit metadata with literal path filters in an isolated read-only project grant', async () => {
    const source = {id: 'commits', projectId: 'remote', connectionId: 'conn', directory: '/src', exclude: ['/src/vendor'], maxEntries: 2, scannerSourceId: 'scanner'};
    const commit = 'a'.repeat(40);
    const exec = vi.fn(async () => ({code: 0, stdout: [commit, '1760000000', 'Update project', ''].join('\0'), stderr: ''}));
    const release = vi.fn(async () => {}), close = vi.fn(async () => {});
    const project = {id: 'server-project', revision: 2, alias: 'repo', path: 'project', access: 'rw', mounts: []};
    const capabilities = {serverId: 'node', processEpoch: 'epoch', pathModel: 'virtual-root', process: {exec: true},
        executionModel: 'sandbox', workspaceConsistency: 'isolated', readOnlyEnforcement: 'kernel-enforced'};
    const executionCapabilities = vi.fn(async () => capabilities);
    const remote = {list: () => [{at: '/', connectionId: 'conn', serverProjectId: project.id, serverProjectRevision: 2, serverId: 'node'}],
        resolveConnection: async () => ({}), executionCapabilities} as unknown as ProjectRemoteMountService;
    const projectProcess = vi.fn(async () => ({nativeShell: {exec}, release}));
    const provider = {projects: () => ({read: async () => project, close}), projectProcess} as unknown as RemoteFileSourceProvider;
    const snapshot = await readDreamGitHistory(remote, provider, source);
    expect(JSON.parse(snapshot.text)).toEqual([{commit, time: 1760000000, subject: 'Update project'}]);
    expect(projectProcess).toHaveBeenCalledWith({}, project, expect.objectContaining({mounts: [{alias: 'repo', path: 'project', at: '/workspace', access: 'ro'}]}));
    expect(exec).toHaveBeenCalledWith('git', expect.arrayContaining(['-n', '2', 'HEAD', '--', ':(top,literal)src', ':(top,exclude,literal)src/vendor']),
        {cwd: '/workspace', timeoutMs: 5000});
    expect(release).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    executionCapabilities.mockResolvedValueOnce({...capabilities, readOnlyEnforcement: 'best-effort'});
    await expect(readDreamGitHistory(remote, provider, source)).rejects.toThrow('DREAM_GIT_UNAVAILABLE');
    expect(projectProcess).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledTimes(2);
});

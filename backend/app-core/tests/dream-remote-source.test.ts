import {expect, it, vi} from 'vitest';
import {scanSources} from '@nestos/dream';
import {dreamRemoteSourcePort} from '../src/dream/remote-source';

it('binds each remote scan to its configured project and rechecks live authority', async () => {
    const authority = {principalId: 'alice', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'remote'};
    const authorizeDreamSource = vi.fn(async () => authority);
    const read = vi.fn(async () => ({items: ['entry'], cursor: 'next', scanned: 1, version: 'v1'}));
    const port = dreamRemoteSourcePort({authorizeDreamSource} as never,
        [{id: 'source', projectId: 'project', connectionId: 'connection', capability: 'sessionRead'}], read);
    const [result] = await scanSources([{id: 'source', projectId: 'project', connectionId: 'connection', cursor: null}], 2, port);
    expect(result.status).toBe('ok');
    expect(authorizeDreamSource).toHaveBeenCalledTimes(2);
    expect(authorizeDreamSource).toHaveBeenCalledWith('project', 'connection', 'sessionRead');
    expect(read).toHaveBeenCalledOnce();
    const [denied] = await scanSources([{id: 'source', projectId: 'other', connectionId: 'connection', cursor: null}], 2, port);
    expect(denied).toMatchObject({status: 'failed', code: 'AUTHORIZATION_FAILED'});
    expect(read).toHaveBeenCalledOnce();
});

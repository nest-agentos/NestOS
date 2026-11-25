import {describe, expect, it, vi} from 'vitest';
import {verifyDreamAuthorization} from '../src/projects/dream-authorization';
import type {ProjectRemoteMount, RemoteFileSourceProvider} from '../src/projects/remote-mounts';

const mount = {serverId: 'server', serverProjectId: 'remote', serverProjectRevision: 4, alias: 'root',
    authorization: {principalId: 'alice', anonymous: false, revision: 'grant-1'}} as ProjectRemoteMount;
const connection = {endpoint: 'https://example.test', credentialRef: 'secret-ref'};

function fixture(overrides: Record<string, unknown> = {}) {
    const project = {id: 'remote', access: 'ro', revision: 4, authorization: {principalId: 'alice', revision: 'grant-1'},
        capabilities: {fileRead: true, sessionRead: true}, ...overrides};
    const close = vi.fn();
    const provider = {discover: async () => ({serverId: 'server', authorization: {principalId: 'alice', anonymous: false, revision: 'grant-1'}}),
        projects: () => ({roots: async () => ({roots: [{alias: 'root', access: 'ro'}]}),
        read: async () => project, close})} as unknown as RemoteFileSourceProvider;
    return {provider, close};
}

describe('Dream live project authorization', () => {
    it('returns only the live identity and revisions after checking the original grant', async () => {
        const {provider, close} = fixture();
        await expect(verifyDreamAuthorization(provider, connection, mount, 'fileRead')).resolves.toEqual({principalId: 'alice',
            revision: 'grant-1', projectRevision: '4', serverId: 'server', serverProjectId: 'remote'});
        expect(close).toHaveBeenCalledOnce();
    });
    it.each([
        {authorization: {principalId: 'mallory', revision: 'grant-1'}},
        {authorization: {principalId: 'alice', revision: 'grant-2'}},
        {id: 'other'}, {revision: 5}, {access: 'denied'}, {capabilities: {fileRead: false, sessionRead: true}},
    ])('rejects changed or insufficient grants: %j', async overrides => {
        const {provider, close} = fixture(overrides);
        await expect(verifyDreamAuthorization(provider, connection, mount, 'fileRead')).rejects.toThrow('DREAM_AUTHORIZATION_DENIED');
        expect(close).toHaveBeenCalledOnce();
    });
    it('rejects unverified provider capabilities', async () => {
        await expect(verifyDreamAuthorization({} as RemoteFileSourceProvider, connection, mount, 'sessionRead'))
            .rejects.toThrow('DREAM_BINDING_UNVERIFIED');
    });
    it('rejects a different server even if the returned project grant matches', async () => {
        const {provider, close} = fixture();
        provider.discover = async () => ({serverId: 'other', authorization: {principalId: 'alice', anonymous: false, revision: 'grant-1'}} as never);
        await expect(verifyDreamAuthorization(provider, connection, mount, 'fileRead')).rejects.toThrow('DREAM_SERVER_IDENTITY_CHANGED');
        expect(close).not.toHaveBeenCalled();
    });
    it('rejects a server identity change during the project inspection', async () => {
        const {provider, close} = fixture(); let calls = 0;
        provider.discover = async () => ({serverId: ++calls === 1 ? 'server' : 'other',
            authorization: {principalId: 'alice', anonymous: false, revision: 'grant-1'}} as never);
        await expect(verifyDreamAuthorization(provider, connection, mount, 'fileRead')).rejects.toThrow('DREAM_SERVER_IDENTITY_CHANGED');
        expect(close).toHaveBeenCalledOnce();
    });
});

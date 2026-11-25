import type {OperationOptions} from '@nestos/vfs-core';
import type {ProjectRemoteMount, RemoteFileConnection, RemoteFileSourceProvider} from './remote-mounts';
import {inspectAuthorization} from './authorization-inspection';

export type DreamReadCapability = 'fileRead' | 'sessionRead';

/** Check the live grant, including resource capability, against the bound project. */
export async function verifyDreamAuthorization(provider: RemoteFileSourceProvider, connection: Omit<RemoteFileConnection, 'alias'>,
    mount: ProjectRemoteMount, capability: DreamReadCapability, options?: OperationOptions) {
    if (!mount.serverProjectId || !mount.serverId || !mount.authorization?.principalId || !mount.authorization.revision || typeof mount.authorization.anonymous !== 'boolean'
        || !Number.isSafeInteger(mount.serverProjectRevision) || !mount.serverProjectRevision) throw new Error('DREAM_BINDING_UNVERIFIED');
    if (!provider.discover) throw new Error('DREAM_BINDING_UNVERIFIED');
    await verifyServer(provider, connection, mount, options);
    const proof = await inspectAuthorization(provider, connection, mount, options);
    if (proof.reason !== 'available' || proof.authentication !== 'accepted' || !['ro', 'rw'].includes(proof.exportAccess)
        || !['ro', 'rw'].includes(proof.projectAccess) || proof.capabilities?.[capability] !== true
        || proof.principalId !== mount.authorization.principalId || proof.authorizationRevision !== mount.authorization.revision
        || proof.projectRevision !== mount.serverProjectRevision || proof.projectId !== mount.serverProjectId) throw new Error('DREAM_AUTHORIZATION_DENIED');
    await verifyServer(provider, connection, mount, options);
    return {principalId: proof.principalId, revision: proof.authorizationRevision, projectRevision: String(proof.projectRevision),
        serverId: mount.serverId, serverProjectId: mount.serverProjectId};
}
async function verifyServer(provider: RemoteFileSourceProvider, connection: Omit<RemoteFileConnection, 'alias'>,
    mount: ProjectRemoteMount, options?: OperationOptions): Promise<void> {
    const descriptor = await provider.discover!(connection, options);
    if (descriptor.serverId !== mount.serverId || descriptor.authorization?.principalId !== mount.authorization?.principalId
        || descriptor.authorization?.anonymous !== mount.authorization?.anonymous
        || descriptor.authorization?.revision !== mount.authorization?.revision) throw new Error('DREAM_SERVER_IDENTITY_CHANGED');
}

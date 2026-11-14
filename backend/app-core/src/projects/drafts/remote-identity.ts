import {FSError, type IFileSystem} from '@nestos/vfs-core';

export interface NativeConversationIdentity {
    connectionId: string;
    serverProjectId: string;
    principalId?: string;
    profileId: string;
    nativeSessionId: string;
}

/** Native IDs are scoped to the authorized project and executor. */
export function nativeIdentityKey(identity: NativeConversationIdentity): string {
    return 'native/' + JSON.stringify([identity.connectionId, identity.serverProjectId, identity.principalId ?? null,
        identity.profileId, identity.nativeSessionId]);
}

export async function readConversationIdentity(fs: IFileSystem, projectId: string, identity: NativeConversationIdentity): Promise<string | undefined> {
    if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new FSError('EINVAL', 'Invalid project identity');
    try {return await fs.meta.seq!.getEntry(`/var/lib/projects/${projectId}/draft.seq`, nativeIdentityKey(identity)) ?? undefined;}
    catch (error) {if (!(error instanceof FSError) || error.code !== 'ENOENT') throw error;}
}

/** Persist the host identity before the first input; native creation alone never promotes a draft. */
export async function bindConversationIdentity(fs: IFileSystem, projectId: string, identity: NativeConversationIdentity, conversationId: string): Promise<void> {
    if (![projectId, conversationId].every(id => /^[a-zA-Z0-9_-]+$/.test(id))) throw new FSError('EINVAL', 'Invalid conversation identity');
    const parentPath = `/var/lib/projects/${projectId}`, path = `${parentPath}/draft.seq`;
    if (!await fs.driver.exists(path)) {
        try {await fs.driver.createFile({parentPath, name: 'draft.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
    }
    await fs.meta.seq!.transaction!(async tx => {
        const key = nativeIdentityKey(identity), current = await tx.getEntry(path, key);
        if (current === conversationId) return;
        if (current !== null) throw new FSError('ECONFLICT', 'Native session is bound to another conversation');
        await tx.setEntry(path, key, conversationId);
    });
}

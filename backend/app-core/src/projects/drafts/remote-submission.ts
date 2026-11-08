import {preparedTitle} from './title';
import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {RemoteConversationStore} from '../remote-conversation-store';
import {ProjectDraftStore} from './store';
import type {ProjectDraftRecord, ProjectDraftPromotion, RemoteDraftTarget} from './contracts';
import {createModuleLogger} from '@nestos/common';
const log = createModuleLogger('project-draft');

export function remoteConversationKey(projectId: string, target: RemoteDraftTarget, conversationId: string): string {
    return JSON.stringify([projectId, target.connectionId, target.serverProjectId,
        ...(target.principalId ? [target.principalId] : []), target.profileId, conversationId]);
}

/** Freeze the authorized executor before any native operation can escape the host. */
export async function prepareRemoteDraft(fs: IFileSystem, projectId: string, draftId: string, target: RemoteDraftTarget, title?: string): Promise<ProjectDraftRecord> {
    const store = new ProjectDraftStore(fs, projectId), record = await store.load();
    if (record.id !== draftId) throw new FSError('ECONFLICT', 'Project draft identity changed');
    return store.begin(preparedTitle(title), target);
}

/** Recovery reads the submission target, never a later input preference. */
export class RemoteDraftRecovery {
    constructor(private readonly fs: IFileSystem,
        private readonly mounts: (projectId: string) => readonly {at: string; connectionId?: string; serverProjectId?: string;
            authorization?: {principalId: string}}[],
        private readonly readRemote?: (projectId: string, target: RemoteDraftTarget, draftId: string) => Promise<{sessionId?: string; submittedTurnId?: string; pending: boolean}>) {}
    private legacyTarget(projectId: string, data: string): RemoteDraftTarget | undefined {
        let identity: unknown;
        try {
            const executor: unknown = JSON.parse(data).config?.agentId;
            if (typeof executor !== 'string' || !executor.startsWith('remote:')) return;
            identity = JSON.parse(decodeURIComponent(executor.slice(7)));
        } catch {return;}
        if (!Array.isArray(identity) || identity.length !== 3 || identity.some(id => typeof id !== 'string' || !id)) return;
        const [connectionId, serverProjectId, profileId] = identity as string[];
        const root = this.mounts(projectId).find(mount => mount.at === '/' && mount.connectionId === connectionId && mount.serverProjectId === serverProjectId);
        if (root) return {connectionId, serverProjectId, ...(root.authorization ? {principalId: root.authorization.principalId} : {}), profileId};
    }
    private journal(projectId: string, record: ProjectDraftRecord) {
        const target = record.remoteTarget ?? this.legacyTarget(projectId, record.data);
        return target ? {target, journal: new RemoteConversationStore(this.fs, remoteConversationKey(projectId, target, record.id))} : undefined;
    }
    private async load(projectId: string, record: ProjectDraftRecord) {
        const source = this.journal(projectId, record), local = await source?.journal.load();
        if (!(local as {remote?: boolean} | undefined)?.remote) return {source, receipt: local};
        if (!this.readRemote) throw new FSError('ECAPABILITY', 'Remote draft recovery is unavailable');
        const started = Date.now();
        try {
            const receipt = await this.readRemote(projectId, source!.target, record.id);
            log.info('draft.recovery', {operationId: record.id, projectId, stage: 'remote-read', result: 'success',
                pending: !!receipt?.pending, submitted: !!receipt?.submittedTurnId, durationMs: Date.now() - started});
            return {source, receipt};
        } catch (error) {
            log.warn('draft.recovery', {operationId: record.id, projectId, stage: 'remote-read', result: 'failure',
                code: error instanceof FSError ? error.code : 'REMOTE_DRAFT_READ_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    async receipt(projectId: string, record: ProjectDraftRecord): Promise<ProjectDraftPromotion['remote'] | undefined> {
        const {source, receipt} = await this.load(projectId, record);
        if (source && receipt?.pending && !record.remoteTarget)
            await prepareRemoteDraft(this.fs, projectId, record.id, source.target);
        if (!receipt?.sessionId || !receipt.submittedTurnId || receipt.pending) return;
        return {...source!.target, nativeSessionId: receipt.sessionId, turnId: receipt.submittedTurnId};
    }
    async assertResettable(projectId: string, record: ProjectDraftRecord): Promise<void> {
        if ((await this.load(projectId, record)).receipt?.pending)
            throw new FSError('EBUSY', 'Reconcile the pending remote submission before discarding the draft');
    }
}

import {arrayBufferToBase64, base64ToArrayBuffer, randomUUID, sha256HexSync, createModuleLogger} from '@nestos/common';
import {FSError, type IFileSystem} from '@nestos/vfs-core';
import type {ProjectClient} from '@nestos/cells-driver';
import type {DraftStore, ProjectDraftRecord, ProjectDraftPromotion, RemoteDraftTarget} from './contracts';
import {bindConversationIdentity} from './remote-identity';
const log = createModuleLogger('cells-project-draft');
type Request = Parameters<NonNullable<ProjectClient['draft']>>[1];

/** The host adapts the node-owned draft; it never allocates a successor identity. */
export class CellsProjectDraftStore implements DraftStore {
    readonly remote = true;
    private record?: ProjectDraftRecord;
    private latestPromotion?: import('@nestos/cells-driver').CellsDraftPromotion;
    constructor(private readonly fs: IFileSystem, private readonly projectId: string,
        private readonly invoke: (input: Request) => ReturnType<NonNullable<ProjectClient['draft']>>) {}
    private async call(input: Request) {
        const started = Date.now();
        try {
            const result = await this.invoke(input);
            log.debug('draft.request', {operationId: input.draftId, projectId: this.projectId, stage: input.action, result: 'success', durationMs: Date.now() - started});
            return result;
        } catch (error) {
            log.warn('draft.request', {operationId: input.draftId, projectId: this.projectId, stage: input.action, result: 'failure',
                code: error instanceof FSError ? error.code : 'CELLS_DRAFT_FAILED', durationMs: Date.now() - started});
            throw error;
        }
    }
    async load(): Promise<ProjectDraftRecord> {
        const result = await this.call({action: 'open'});
        if (!result.record) throw new FSError('EIO', 'Cells draft record is missing');
        this.record = result.record;
        this.latestPromotion = result.promotion ?? undefined;
        await this.discardLegacy();
        return {...this.record};
    }
    private binding(id: string, target?: RemoteDraftTarget) {
        return target ? {namespace: sha256HexSync(JSON.stringify(['conversation', id, target.profileId])), profileId: target.profileId} : {};
    }
    private current() {if (!this.record) throw new FSError('EINVAL', 'Cells draft is not loaded'); return this.record;}
    async saveData(data: string): Promise<void> {
        const record = this.current();
        const result = await this.call({action: 'save', draftId: record.id, expectedData: record.data, data});
        if (!result.record) throw new FSError('EIO', 'Cells draft save is unconfirmed');
        this.record = result.record;
    }
    async reset(): Promise<void> {
        const result = await this.call({action: 'reset', draftId: this.current().id});
        if (!result.record) throw new FSError('EIO', 'Cells draft reset is unconfirmed');
        this.record = result.record;
    }
    async begin(title: string, target?: RemoteDraftTarget, harnessConnectionId?: string): Promise<ProjectDraftRecord> {
        if (!target && !harnessConnectionId) throw new FSError('ECAPABILITY', 'Cells drafts require a native executor');
        const record = this.current();
        const result = await this.call({action: 'begin', draftId: record.id, expectedData: record.data, title, target, harnessConnectionId, ...this.binding(record.id, target)});
        if (!result.record) throw new FSError('EIO', 'Cells draft preparation is unconfirmed');
        return this.record = result.record;
    }
    async wasPromoted(): Promise<boolean> {return !!(await this.call({action: 'promotion', draftId: this.current().id})).promotion;}
    async promote(): Promise<ProjectDraftPromotion | undefined> {
        const record = this.current();
        const result = await this.call({action: record.harnessConnectionId ? 'commit_session' : 'promote', draftId: record.id, submissionId: record.submissionId});
        const p = result.promotion;
        if (!p) return;
        return this.projectPromotion(p);
    }
    async recoverPromotion(): Promise<ProjectDraftPromotion | undefined> {
        return this.latestPromotion ? this.projectPromotion(this.latestPromotion) : undefined;
    }
    private async projectPromotion(p: import('@nestos/cells-driver').CellsDraftPromotion): Promise<ProjectDraftPromotion> {
        const remote = p.remoteTarget && p.nativeSessionId && p.turnId ? {...p.remoteTarget, nativeSessionId: p.nativeSessionId, turnId: p.turnId} : undefined;
        if (remote) await bindConversationIdentity(this.fs, this.projectId, remote, p.draftId);
        return {type: 'project.draftPromoted', projectId: this.projectId, draftId: p.draftId, sessionId: p.draftId,
            submissionId: p.submissionId, nextDraftId: p.nextDraftId, state: 'promoted', remote};
    }
    private async discardLegacy(): Promise<void> {
        const path = `/var/lib/projects/${this.projectId}/draft.seq`, marker = 'cells-draft-legacy-cleanup';
        if (!await this.fs.driver.exists(path)) return;
        const raw = await this.fs.meta.seq!.getEntry(path, 'draft');
        if (raw === null && !await this.fs.meta.seq!.getEntry(path, marker)) return;
        if (raw !== null) await this.fs.meta.seq!.transaction!(async tx => {
            if (!await tx.compareAndSet(path, 'draft', {expected: raw, value: null})) throw new FSError('ECONFLICT', 'Legacy HTTP draft changed during discard');
            await tx.setEntry(path, marker, 'pending');
        });
        const attachments = `/var/lib/projects/${this.projectId}/draft-attachments`, started = Date.now();
        try {
            if (await this.fs.driver.exists(attachments)) await this.fs.driver.delete([attachments], {recursive: true});
            await this.fs.meta.seq!.deleteEntry(path, marker);
            log.info('draft.cleanup', {operationId: this.current().id, projectId: this.projectId, stage: 'legacy-attachments', result: 'success', durationMs: Date.now() - started});
        } catch {
            log.warn('draft.cleanup', {operationId: this.current().id, projectId: this.projectId, stage: 'legacy-attachments', result: 'deferred', code: 'LEGACY_DRAFT_CLEANUP_FAILED', durationMs: Date.now() - started});
        }
    }
    async putAttachment(content: ArrayBuffer): Promise<string> {const id = randomUUID(); await this.putAsset(id, content); return id;}
    private async putAsset(id: string, content: ArrayBuffer): Promise<void> {
        const record = this.current(), encoded = arrayBufferToBase64(content);
        if (encoded.length > 512 * 131072) throw new FSError('EFBIG', 'Cells draft attachment is too large');
        const parts = Math.ceil(encoded.length / 131072);
        for (let i = 0; i < parts; i++) await this.call({action: 'asset_put', draftId: record.id, assetId: id, part: i + 1, value: encoded.slice(i * 131072, (i + 1) * 131072)});
        await this.call({action: 'asset_put', draftId: record.id, assetId: id, part: 0, value: JSON.stringify({parts, sha256: sha256HexSync(encoded)})});
    }
    async readAttachment(id: string): Promise<ArrayBuffer> {
        const record = this.current(), read = async (part: number) => {
            const result = await this.call({action: 'asset_read', draftId: record.id, assetId: id, part});
            if (typeof result.value !== 'string') throw new FSError('ENOENT', 'Cells draft attachment is missing'); return result.value;
        };
        const head = JSON.parse(await read(0)) as {parts: number; sha256: string};
        if (!Number.isInteger(head.parts) || head.parts < 0 || head.parts > 512) throw new FSError('EIO', 'Invalid Cells attachment manifest');
        const chunks: string[] = [];
        for (let i = 0; i < head.parts; i++) chunks.push(await read(i + 1));
        const encoded = chunks.join('');
        if (sha256HexSync(encoded) !== head.sha256) throw new FSError('EIO', 'Cells draft attachment integrity mismatch');
        return base64ToArrayBuffer(encoded);
    }
}

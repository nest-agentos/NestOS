import {preparedTitle} from './title';
import {mapConcurrent} from '../../utils/map-concurrent';
import { FSError } from '@nestos/vfs-core';
import type { ISessionRepository } from '@nestos/llm-session';
import { type SessionSubmission } from '@nestos/llm-flow/contracts';
import { hasCommittedSubmission } from '@nestos/llm-session';
import type { ProjectDraftPromotion, ProjectDraftRecord, ProjectDraftComposer, DraftStore } from './contracts';

/** Reconcile from durable evidence; notifications never create successor drafts. */
export class ProjectDraftService {
    private readonly published = new Map<string, string>();
    private readonly listeners = new Set<(event: ProjectDraftPromotion) => void>();
    constructor(private readonly store: (projectId: string) => DraftStore, private readonly sessions: Pick<ISessionRepository, 'ensureSession' | 'readDocument' | 'getManifest' | 'saveSessionSettings'>,
        private readonly projectIds: () => Promise<string[]>, private readonly assertLocal?: (projectId: string, request?: Parameters<ProjectDraftComposer['prepare']>[0]) => Promise<string | void>,
        private readonly remoteReceipt?: (projectId: string, record: ProjectDraftRecord) => Promise<ProjectDraftPromotion['remote'] | undefined>,
        private readonly initializeExecution?: (sessionId: string) => Promise<void>,
        private readonly assertResettable?: (projectId: string, record: ProjectDraftRecord) => Promise<void>) {}
    async open(projectId: string, folder: string): Promise<ProjectDraftComposer> {
        const store = this.store(projectId), initial = await store.load();
        await this.reconcileRecord(projectId, store, initial);
        const record = store.remote && initial.state === 'draft' && !initial.harnessConnectionId ? initial : await store.load();
        let identity = record.id;
        let resumeOnly = record.state === 'submitting';
        let locked = resumeOnly;
        return {
            acceptsDraftOnPrepare: true,
            get id() {return identity;},
            get locked() {return locked;},
            initialData: record.data,
            refresh: async () => {
                await this.reconcile(projectId);
                const current = await this.store(projectId).load();
                return current.id !== identity || (current.state === 'submitting') !== locked || await store.wasPromoted() ? this.open(projectId, folder) : undefined;
            },
            attachments: { put: content => store.putAttachment(content), read: id => store.readAttachment(id) },
            move: async targetProjectId => {
                if (!(await this.projectIds()).includes(targetProjectId)) throw new FSError('ENOENT', 'Target project not found');
                const current = await this.store(projectId).load();
                if (!store.remote && current.id === identity) await this.assertResettable?.(projectId, current);
                if (!store.moveTo) throw new FSError('ECAPABILITY', 'Draft project switching is unavailable');
                await store.moveTo(targetProjectId);
            },
            save: data => store.saveData(data), clear: async () => {
                const current = await this.store(projectId).load();
                if (current.id !== identity) throw new FSError('ECONFLICT', 'Project draft identity changed');
                if (!store.remote) await this.assertResettable?.(projectId, current);
                await store.reset(); identity = (await store.load()).id; resumeOnly = false; locked = false; return identity;
            },
            prepare: async request => {
                const harnessConnectionId = await this.assertLocal?.(projectId, request) || undefined;
                if (request?.data !== undefined && typeof request.data !== 'string') throw new FSError('EINVAL', 'Invalid draft data');
                if (store.remote && request?.data !== undefined) await store.saveData(request.data);
                const intent = await store.begin(preparedTitle(request?.title), undefined, harnessConnectionId, request?.data);
                locked = true;
                await this.sessions.ensureSession(intent.sessionId!, intent.title!, 'tauri', folder, null, {agentId: draftAgent(intent.data)});
                if (harnessConnectionId) await this.sessions.saveSessionSettings(intent.sessionId!, {harnessConnectionId});
                await this.initializeExecution?.(intent.sessionId!);
                return { sessionId: intent.sessionId!, resumeOnly, submission: submissionOf(projectId, intent) };
            },
        };
    }
    async ensure(projectId: string): Promise<void> { const store = this.store(projectId); if (!store.remote) await store.load(); }
    onPromoted(listener: (event: ProjectDraftPromotion) => void): () => void {
        this.listeners.add(listener); return () => this.listeners.delete(listener);
    }
    async submissionForSession(projectId: string, sessionId: string) {
        await this.reconcile(projectId, sessionId);
        const record = await this.store(projectId).load();
        return record.state === 'submitting' && record.sessionId === sessionId && record.submissionId
            ? submissionOf(projectId, record) : undefined;
    }
    async submitted(event: { sessionId: string; roundId: string; submission?: SessionSubmission }): Promise<void> {
        if (event.submission?.source.kind !== 'project-draft' || event.submission.id !== event.roundId) return;
        await this.reconcile(event.submission.source.ownerId, event.sessionId, event.roundId);
    }
    async recover(sessionId?: string, roundId?: string, deferred?: (projectId: string, error: unknown) => void): Promise<void> {
        const failures: unknown[] = [];
        await mapConcurrent(await this.projectIds(), 4, async projectId => {
            try { await this.reconcile(projectId, sessionId, roundId); }
            catch (error) { failures.push(error); deferred?.(projectId, error); }
        });
        if (failures.length) throw new AggregateError(failures, 'Project draft recovery deferred');
    }
    async reconcile(projectId: string, sessionId?: string, roundId?: string): Promise<void> {
        const draft = this.store(projectId), record = await draft.load();
        await this.reconcileRecord(projectId, draft, record, sessionId, roundId);
    }
    private async reconcileRecord(projectId: string, draft: DraftStore, record: ProjectDraftRecord, sessionId?: string, roundId?: string): Promise<void> {
        this.publish(await draft.recoverPromotion?.());
        if (draft.remote && !record.harnessConnectionId) {
            if (record.state === 'submitting') this.publish(await draft.promote());
            return;
        }
        const remote = draft.remote ? undefined : await this.remoteReceipt?.(projectId, record);
        if (remote) {this.publish(await draft.promote(remote)); return;}
        if (record.remoteTarget || record.state !== 'submitting' || !record.sessionId || !record.submissionId) return;
        if (sessionId && record.sessionId !== sessionId || roundId && record.submissionId !== roundId) return;
        try {
            if (!await hasCommittedSubmission(this.sessions, record.sessionId, submissionOf(projectId, record)!)) return;
            const event = await draft.promote();
            this.publish(event);
        } catch (error) {
            if (!(error instanceof FSError) || !['ENOENT', 'ECONFLICT'].includes(error.code)) throw error;
        }
    }
    private publish(event?: ProjectDraftPromotion): void {
        if (!event || this.published.get(event.projectId) === event.draftId) return;
        this.published.set(event.projectId, event.draftId);
        for (const listener of this.listeners) {
            try {listener(event);} catch (error) {console.warn('Project draft notification failed', error);}
        }
    }
}

function submissionOf(projectId: string, record: ProjectDraftRecord): SessionSubmission | undefined {
    return record.submissionId ? { id: record.submissionId, source: { kind: 'project-draft', ownerId: projectId, id: record.id } } : undefined;
}
function draftAgent(data: string): string | undefined {
    try {
        const config = JSON.parse(data).config;
        if (config?.target?.kind === 'flow') return;
        const id: unknown = config?.agentId;
        return typeof id === 'string' && !!id.trim() && !id.startsWith('remote:') ? id : undefined;
    }
    catch { return undefined; }
}

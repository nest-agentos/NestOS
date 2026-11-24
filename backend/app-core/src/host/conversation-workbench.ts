import {FSError} from '@nestos/vfs-core';
import {folderBrowserPath, folderPathFromBrowserPath, resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {ApplicationBackend, ConversationWorkbenchRequest, ConversationWorkbenchView, LocalApplicationServices, PreparedConversation, ProjectFolder, WorkbenchNavigationRequest, WorkbenchNavigationView, WorkbenchView} from '@nestos/app-contracts/services';
import {ViewScope} from './view-scope';
import {ViewObservation} from './view-observation';
import {prepareConversation} from './prepare-conversation';

const log = createModuleLogger('resource-workbench');
/** Composition of independent domain ports with one explicit observation lifetime. */
export class ResourceWorkbench implements ConversationWorkbenchView {
    resourceId = '';
    private chatPreparation?: Promise<NonNullable<WorkbenchView['chat']>>;
    documents: Record<string, unknown> = {};
    native?: PreparedConversation;
    failure?: ConversationWorkbenchView['failure'];
    workbench!: WorkbenchView;
    private readonly eventSource: ViewObservation;
    cursor = 0;
    private closed = false;
    private visible = true;
    private interestRevision = 0;
    private conversationRevision = 0;
    private readonly nativeViews = new Set<PreparedConversation>();
    private readonly interests = new Set<string>();
    private closing?: Promise<void>;
    private readonly resources = new ViewScope();
    private readonly statusStops = new Map<string, () => void>();
    constructor(private readonly services: LocalApplicationServices, private readonly chatFactory?: () => Promise<NonNullable<WorkbenchView['chat']>>) {this.eventSource = new ViewObservation(services);}
    async initialize(backend: ApplicationBackend, request: ConversationWorkbenchRequest): Promise<this> {
        const started = performance.now(), operationId = randomUUID();
        try {
            this.resourceId = request.resourceId;
            const target = resolveBrowserTarget(request.resourceId);
            const native = target.kind === 'remote' && !!target.nativeSessionId;
            const chatControls = !native && !['project-files', 'files', 'folder', 'favorites', 'favorite'].includes(target.kind);
            await this.prepareView(backend, request, chatControls);
            const folder = 'folder' in target ? target.folder : target.kind === 'folder' ? folderPathFromBrowserPath(target.path) : undefined;
            await this.prepareTarget(request.resourceId, folder, native);
            await this.eventSource.addChat(this.workbench);
            if (this.closed) throw new FSError('EIO', 'Workbench closed');
            this.cursor = this.eventSource.getViewCursor();
            log.info('resource.open', {operation: 'workbench.open', operationId, stage: 'prepare', result: 'success', resourceKind: target.kind, durationMs: Math.round(performance.now() - started)});
            return this;
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            log.warn('resource.open', {operation: 'workbench.open', operationId, stage: 'prepare', result: 'failure', code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'WORKBENCH_OPEN_FAILED', durationMs: Math.round(performance.now() - started)});
            await this.dispose(); throw error;
        }
    }
    private async prepareTarget(resourceId: string, folder: string | null | undefined, native: boolean): Promise<void> {
        const project = folder ? await this.services.projects.forFolder(folder) : null;
        if (project) await this.updateProjectInterest(project.project.id);
        if (native) {
            try { await this.openNativeConversation(resourceId, project ?? null); }
            catch (error) { this.failedOpening(resourceId, error); }
        }
    }
    private async prepareView(backend: ApplicationBackend, request: ConversationWorkbenchRequest, chatControls: boolean): Promise<void> {
        const results = await Promise.allSettled([backend.workbenchView({chatControls, initialNavigation: false, displayedFilesPolicy: request.displayedFilesPolicy}), backend.readUiDocuments(request.documents)]);
        if (results[0].status === 'fulfilled') {
            this.workbench = results[0].value;
            await this.resources.own({dispose: () => closeWorkbench(this.workbench)});
        }
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        this.documents = (results[1] as PromiseFulfilledResult<Record<string, unknown>>).value;
        this.eventSource.addSource('navigation', listener => this.workbench.browser.fs.onAny?.(listener) ?? (() => {}));
    }
    async prepareChat(): Promise<NonNullable<WorkbenchView['chat']>> {
        if (this.closed) throw new FSError('EIO', 'Workbench closed');
        if (this.workbench.chat) return this.workbench.chat;
        if (!this.chatFactory) throw new FSError('ECAPABILITY', 'Chat preparation unavailable');
        return this.chatPreparation ??= this.loadChat().catch(error => {this.chatPreparation = undefined; throw error;});
    }
    private async loadChat(): Promise<NonNullable<WorkbenchView['chat']>> {
        const started = performance.now(), operationId = randomUUID();
        let chat: WorkbenchView['chat'];
        try {
            chat = await this.chatFactory!();
            if (this.closed) throw new FSError('EIO', 'Workbench closed');
            await this.eventSource.addChat({...this.workbench, chat});
            if (this.closed) throw new FSError('EIO', 'Workbench closed');
            this.workbench.chat = chat;
            log.info('chat.prepare', {operation: 'workbench.chat.prepare', operationId, stage: 'controls', result: 'success', durationMs: Math.round(performance.now() - started)});
            return chat;
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            log.warn('chat.prepare', {operation: 'workbench.chat.prepare', operationId, stage: 'controls', result: 'failure', code: typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'WORKBENCH_CHAT_PREPARATION_FAILED', durationMs: Math.round(performance.now() - started)});
            await chat?.configuration?.dispose(); throw error;
        }
    }
    private failedOpening(resourceId: string, error: unknown): void {
        const raw = (error as {code?: unknown})?.code, reason = (error as {reason?: unknown})?.reason;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'CONVERSATION_OPEN_FAILED';
        this.failure = {resourceId, code, ...(reason === 'REMOTE_PROJECT_MISSING' ? {reason} : {})};
        log.warn('conversation.unavailable', {operation: 'workbench.conversation', operationId: randomUUID(), stage: 'open', result: 'failure', code, durationMs: 0});
    }
    get observation(): ViewObservation {return this.eventSource;}
    eventSnapshot() {return this.eventSource.eventSnapshot();}
    subscribe(listener: Parameters<ViewObservation['observeView']>[1]) {return this.eventSource.observeView(this.eventSource.getViewCursor(), listener);}
    openConversation(resourceId: string): Promise<PreparedConversation> {
        return this.openNativeConversation(resourceId);
    }
    private async openNativeConversation(resourceId: string, project?: ProjectFolder | null): Promise<PreparedConversation> {
        if (this.closed) throw new FSError('EIO', 'Workbench closed');
        const revision = ++this.conversationRevision;
        const prepared = await prepareConversation(this.services.projects, resourceId, project);
        if (this.closed) {await prepared.conversation.close(); throw new FSError('EIO', 'Workbench closed');}
        const owned = await this.ownConversation(prepared);
        if (this.closed) {await owned.conversation.close(); throw new FSError('EIO', 'Workbench closed');}
        if (revision !== this.conversationRevision) return owned;
        this.native = owned; this.failure = undefined;
        try {
            if (project === undefined) await this.updateProjectInterest(prepared.project.project.id);
            return owned;
        } catch (error) {await Promise.allSettled([owned.conversation.close()]); throw error;}
    }
    private async ownConversation(prepared: PreparedConversation): Promise<PreparedConversation> {
        const source = prepared.conversation;
        let owned: PreparedConversation | undefined, stop: () => void;
        try {stop = this.eventSource.addSource('conversation', listener => source.subscribe(() => listener({resourceId: prepared.resourceId})));}
        catch (error) {await Promise.allSettled([source.close()]); throw error;}
        const owner = await this.resources.own({dispose: async () => {
            if (owned) {
                this.nativeViews.delete(owned);
                if (this.native === owned) this.native = [...this.nativeViews].at(-1);
            }
            try {stop();} finally {await source.close();}
        }});
        owned = {...prepared, conversation: new Proxy(source, {get(target, key) {
            if (key === 'close') return owner.dispose;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }})};
        this.nativeViews.add(owned);
        return owned;
    }
    async readNavigation(request: WorkbenchNavigationRequest): Promise<WorkbenchNavigationView> {
        if (this.closed) throw new FSError('EIO', 'Workbench closed');
        const paths = this.navigationPaths(request.expandedPaths ?? []), resourceId = request.resourceId ?? this.native?.resourceId ?? this.resourceId;
        if (resourceId !== undefined && (typeof resourceId !== 'string' || resourceId.length > 4096)) throw new FSError('EINVAL', 'Invalid navigation target');
        const target = resourceId && resolveBrowserTarget(resourceId);
        const path = target && (target.kind === 'remote' || target.kind === 'project-files' || target.kind === 'favorites' || target.kind === 'favorite') ? folderBrowserPath(target.folder) : '/';
        const started = performance.now(), operationId = randomUUID();
        try {
            const data = await this.workbench.browser.readDirectory!(path, {projectId: request.projectId, includeAncestors: true, includePaths: paths});
            const statuses: WorkbenchNavigationView['statuses'] = {};
            for (const project of (data.navigation?.projects ?? []).filter(project => !request.projectId || project.project.id === request.projectId).slice(0, 16)) {
                const id = project.project.id;
                if (!this.services.projects.remoteMounts?.list(id).some(mount => mount.at === '/' && mount.serverProjectId)) continue;
                if (this.interests.has(id)) this.observeStatus(id);
                statuses[id] = this.services.projects.remoteMounts.sessionStatus.records?.(id) ?? [];
            }
            await this.workbench.connections?.update(this.visible ? [...this.interests] : [], ++this.interestRevision);
            log.info('navigation.read', {operation: 'workbench.navigation', operationId, stage: 'prepare', result: 'success', count: data.directories.length, durationMs: Math.round(performance.now() - started)});
            return {...data, statuses, navigation: data.navigation && {...data.navigation, path: resourceId ?? '/'}};
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('navigation.read', {operation: 'workbench.navigation', operationId, stage: 'prepare', result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'WORKBENCH_NAVIGATION_FAILED', durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
    private navigationPaths(paths: string[]): string[] {
        if (!Array.isArray(paths) || paths.length > 64 || paths.some(path => typeof path !== 'string' || path.length > 4096)) throw new FSError('EINVAL', 'Invalid navigation interests');
        return [...new Set(paths)].filter(path => {
            const target = resolveBrowserTarget(path);
            return target.kind === 'folder' || target.kind === 'project-conversations';
        });
    }
    private async updateProjectInterest(projectId: string): Promise<void> {
        this.selectProject(projectId);
        await this.workbench.connections?.update(this.visible ? [...this.interests] : [], ++this.interestRevision);
    }
    private selectProject(projectId: string): void {
        for (const id of this.interests) if (id !== projectId) {
            this.interests.delete(id); this.statusStops.get(id)?.();
        }
        this.observeStatus(projectId);
    }
    private observeStatus(projectId: string): void {
        this.interests.add(projectId);
        const status = this.services.projects.remoteMounts?.sessionStatus;
        if (!this.visible || !status || this.statusStops.has(projectId)) return;
        const stop = this.eventSource.addSource('remoteStatus', listener =>
            status.subscribe(projectId, () => listener({projectId, rows: status.records?.(projectId) ?? []})));
        this.statusStops.set(projectId, () => {stop(); this.statusStops.delete(projectId);});
    }
    async setVisible(visible: boolean): Promise<void> {
        if (typeof visible !== 'boolean') throw new FSError('EINVAL', 'Invalid visibility');
        if (this.closed || visible === this.visible) return;
        this.visible = visible;
        if (visible) for (const id of this.interests) this.observeStatus(id);
        else for (const stop of [...this.statusStops.values()]) stop();
        await this.workbench.connections?.update(visible ? [...this.interests] : [], ++this.interestRevision);
    }
    dispose(): Promise<void> {return this.closing ??= this.close();}
    private async close(): Promise<void> {
        this.closed = true;
        const results = await Promise.allSettled([this.eventSource.dispose(), this.resources.close()]);
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, 'Conversation workbench cleanup failed');
    }
}

async function closeWorkbench(view: WorkbenchView): Promise<void> {
    const results = await Promise.allSettled([view.browser.dispose(), view.chat?.configuration?.dispose(), view.connections?.dispose()]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Workbench resource cleanup failed');
}

export {ResourceWorkbench as ConversationWorkbench};

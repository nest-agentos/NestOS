import {FSError} from '@nestos/vfs-core';
import {folderBrowserPath, resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {ApplicationBackend, ConversationWorkbenchRequest, ConversationWorkbenchView, LocalApplicationServices, PreparedConversation, WorkbenchNavigationRequest, WorkbenchNavigationView, WorkbenchView} from '@nestos/app-contracts/services';
import {ViewScope} from './view-scope';
import {ViewObservation} from './view-observation';
import {prepareConversation} from './prepare-conversation';

const log = createModuleLogger('conversation-workbench');
/** Composition of independent domain ports with one explicit observation lifetime. */
export class ConversationWorkbench implements ConversationWorkbenchView {
    documents: Record<string, unknown> = {};
    native?: PreparedConversation;
    failure?: ConversationWorkbenchView['failure'];
    workbench!: WorkbenchView;
    private readonly eventSource: ViewObservation;
    cursor = 0;
    private closed = false;
    private visible = true;
    private interestRevision = 0;
    private readonly interests = new Set<string>();
    private closing?: Promise<void>;
    private readonly resources = new ViewScope();
    private readonly statusStops = new Map<string, () => void>();
    constructor(private readonly services: LocalApplicationServices) {this.eventSource = new ViewObservation(services);}
    async initialize(backend: ApplicationBackend, request: ConversationWorkbenchRequest): Promise<this> {
        try {
            const results = await Promise.allSettled([backend.workbenchView({chatControls: true, initialNavigation: false, displayedFilesPolicy: request.displayedFilesPolicy}), backend.readUiDocuments(request.documents)]);
            if (results[0].status === 'fulfilled') {
                this.workbench = results[0].value;
                await this.resources.own({dispose: () => closeWorkbench(this.workbench)});
            }
            const failure = results.find(result => result.status === 'rejected');
            if (failure?.status === 'rejected') throw failure.reason;
            this.documents = (results[1] as PromiseFulfilledResult<Record<string, unknown>>).value;
            this.eventSource.addSource('navigation', listener => this.workbench.browser.fs.onAny?.(listener) ?? (() => {}));
            try {this.native = await this.openConversation(request.resourceId);}
            catch (error) {this.failedOpening(request.resourceId, error);}
            if (this.closed) throw new FSError('EIO', 'Workbench closed');
            this.cursor = this.eventSource.getViewCursor();
            return this;
        } catch (error) {await this.dispose(); throw error;}
    }
    private failedOpening(resourceId: string, error: unknown): void {
        const raw = (error as {code?: unknown})?.code, reason = (error as {reason?: unknown})?.reason;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'CONVERSATION_OPEN_FAILED';
        this.failure = {resourceId, code, ...(reason === 'REMOTE_PROJECT_MISSING' ? {reason} : {})};
        log.warn('conversation.unavailable', {operation: 'workbench.conversation', operationId: randomUUID(), stage: 'open', result: 'failure', code, durationMs: 0});
    }
    eventSnapshot() {return this.eventSource.eventSnapshot();}
    subscribe(listener: Parameters<ViewObservation['observeView']>[1]) {return this.eventSource.observeView(this.eventSource.getViewCursor(), listener);}
    async openConversation(resourceId: string): Promise<PreparedConversation> {
        if (this.closed) throw new FSError('EIO', 'Workbench closed');
        const prepared = await prepareConversation(this.services.projects, resourceId);
        if (this.closed) {await prepared.conversation.close(); throw new FSError('EIO', 'Workbench closed');}
        this.native = prepared; this.failure = undefined;
        await this.resources.own({dispose: () => prepared.conversation.close()});
        this.eventSource.addSource('conversation', listener => prepared.conversation.subscribe(() => listener({resourceId})));
        this.observeStatus(prepared.project.project.id);
        await this.workbench.connections?.update([...this.interests], ++this.interestRevision);
        return prepared;
    }
    async readNavigation(request: WorkbenchNavigationRequest): Promise<WorkbenchNavigationView> {
        if (this.closed) throw new FSError('EIO', 'Workbench closed');
        const paths = this.navigationPaths(request.expandedPaths ?? []), resourceId = request.resourceId ?? this.native?.resourceId;
        if (resourceId !== undefined && (typeof resourceId !== 'string' || resourceId.length > 4096)) throw new FSError('EINVAL', 'Invalid navigation target');
        const target = resourceId && resolveBrowserTarget(resourceId);
        const path = target && target.kind === 'remote' ? folderBrowserPath(target.folder) : '/';
        const started = performance.now(), operationId = randomUUID();
        try {
            const data = await this.workbench.browser.readDirectory!(path, {projectId: request.projectId, includeAncestors: true, includePaths: paths});
            const statuses: WorkbenchNavigationView['statuses'] = {};
            for (const project of (data.navigation?.projects ?? []).filter(project => !request.projectId || project.project.id === request.projectId).slice(0, 16)) {
                const id = project.project.id;
                if (!this.services.projects.remoteMounts?.list(id).some(mount => mount.at === '/' && mount.serverProjectId)) continue;
                this.observeStatus(id); statuses[id] = this.services.projects.remoteMounts.sessionStatus.records?.(id) ?? [];
            }
            await this.workbench.connections?.update([...this.interests], ++this.interestRevision);
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

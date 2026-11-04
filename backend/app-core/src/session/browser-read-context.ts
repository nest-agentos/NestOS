import {createModuleLogger, randomUUID} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';
import type {FileSystemSourceOwner} from '@nestos/vfs-core';
import type {ISessionRepository} from '@nestos/llm-session/contracts';
import type {ProjectService, ProjectFolder, ProjectNavigationView} from '@nestos/app-contracts/services';
import {navigationFolders} from '../projects/navigation-folders';

const log = createModuleLogger('browser-query');

/** One display query owns its read promises and borrowed workspaces, never a cross-query cache. */
export class BrowserReadContext {
    private closed = false;
    private closing?: Promise<void>;
    readonly operationId = randomUUID();
    private readonly started = performance.now();
    private navigationRead?: Promise<ProjectNavigationView | undefined>;
    private catalogRead?: Promise<ProjectFolder[]>;
    private rawFolderRead?: ReturnType<ISessionRepository['listFolders']>;
    private folderRead?: ReturnType<ISessionRepository['listFolders']>;
    private readonly workspaces = new Map<string, Promise<FileSystemSourceOwner>>();
    private readonly favorites = new Map<string, ReturnType<ProjectService['favorites']['list']>>();
    constructor(private readonly repository: ISessionRepository, private readonly projects: ProjectService | undefined,
        private readonly path: string, private readonly options: {projectId?: string | null} = {}) {}
    navigation(): Promise<ProjectNavigationView | undefined> {
        return this.navigationRead ??= this.track('navigation', () => this.projects?.navigation({path: this.path, projectId: this.options.projectId}) ?? Promise.resolve(undefined));
    }
    catalog(): Promise<ProjectFolder[]> {
        return this.catalogRead ??= this.rawFolders().then(folders => this.projects?.list(folders) ?? []);
    }
    private rawFolders(): ReturnType<ISessionRepository['listFolders']> {
        return this.rawFolderRead ??= this.track('folders', () => this.repository.listFolders());
    }
    folders(): ReturnType<ISessionRepository['listFolders']> {
        return this.folderRead ??= Promise.all([this.rawFolders(), this.catalog()])
            .then(([folders, projects]) => this.projects ? navigationFolders(projects, folders) : folders);
    }
    async project(folder: string | null | undefined): Promise<ProjectFolder | undefined> {
        return (await this.catalog()).filter(project => folder === project.path || folder?.startsWith(project.path + '/'))
            .sort((a, b) => b.path.length - a.path.length)[0];
    }
    loadFavorites(id: string): ReturnType<ProjectService['favorites']['list']> {
        let pending = this.favorites.get(id);
        if (!pending) {pending = this.projects?.favorites.list(id) ?? Promise.resolve([]); this.favorites.set(id, pending);}
        return pending;
    }
    workspace(folder: string): Promise<FileSystemSourceOwner> {
        if (this.closed) return Promise.reject(new FSError('EACCES', 'Browser query is closed'));
        let pending = this.workspaces.get(folder);
        if (!pending) {
            if (!this.projects) return Promise.reject(new FSError('ENOENT', 'Projects unavailable'));
            pending = this.track('workspace.open', () => this.projects!.openWorkspace(folder)); this.workspaces.set(folder, pending);
        }
        return pending;
    }
    private async track<T>(stage: string, read: () => Promise<T>): Promise<T> {
        const started = performance.now();
        try {
            const value = await read();
            log.debug('browser.query', {operation: 'browser.query', operationId: this.operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
            return value;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            log.warn('browser.query', {operation: 'browser.query', operationId: this.operationId, stage, result: 'failure',
                code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'BROWSER_QUERY_READ_FAILED', durationMs: Math.round(performance.now() - started)});
            throw error;
        }
    }
    close(): Promise<void> {return this.closing ??= this.release();}
    private async release(): Promise<void> {
        this.closed = true;
        const opened = await Promise.allSettled(this.workspaces.values()); this.workspaces.clear();
        await Promise.allSettled([this.navigationRead, this.catalogRead, this.folderRead, ...this.favorites.values()]);
        const closed = await Promise.allSettled(opened.map(result => result.status === 'fulfilled' ? result.value.dispose() : undefined));
        log.info('browser.query', {operation: 'browser.query', operationId: this.operationId, stage: 'release',
            result: closed.some(row => row.status === 'rejected') ? 'failure' : 'success', workspaceCount: opened.length, favoriteCount: this.favorites.size,
            code: closed.some(row => row.status === 'rejected') ? 'BROWSER_QUERY_CLEANUP_FAILED' : undefined, durationMs: Math.round(performance.now() - this.started)});
        const errors = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'Browser query workspace cleanup failed');
    }
}

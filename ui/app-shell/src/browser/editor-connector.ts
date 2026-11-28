import {navigateWorkspaceBack} from '../navigation/page-history';
import {createRecoverableFileEditor} from './file-recovery';
import { showNameDialog } from '../files/project-dialog';
import { createModuleLogger, t, FILE_BROWSER_ICONS, FILE_ICONS, randomUUID, type NavigationRequest } from '@nestos/common';
import { directoryBulkActions } from '../workbench/vfs-actions';
import { watchDirectoryList } from '../workbench/directory-watch';
import type { EditorFactory, IEditor, EditorHostContext } from '@nestos/ui-common-adapter';
import type { IFileSystem, FileSystemContext } from '@nestos/vfs-core';
import { FSError, guessMimeType } from '@nestos/vfs-core';
import { allowsRowAction, filterGitignoredFiles, type VFSUIShell, type VFSNodeUI } from '@nestos/vfs-ui';
import { EditorLease } from './editor-lease';
import { fileContentFormat } from './file-format';
import { parseFileInfo, extractTaskCounts } from './parser';
import { MediaViewerEditor, isBinaryViewable } from './MediaViewerEditor';
import { LatestViewLoad, type ViewLoad } from '../lifecycle/view-load';
import { WorkbenchTabs, type WorkbenchTab } from '../workbench/tabs';
import { WorkbenchSidebar } from '../workbench/sidebar';
import { createDirectoryList, refreshDirectoryList, relocateDirectoryList, watchDirectorySelection } from '../workbench/directory-list';
import type { WorkbenchStatePort } from '../workbench/state';
import { fileWindowLabel } from '../workbench/window-identity';
import { fileDirectoryBreadcrumbs } from '../workbench/directory-breadcrumbs';

export interface ConnectOptions<Node extends VFSNodeUI = VFSNodeUI> {
    directoryActions?: Array<{id: string; label: string; icon?: string; run(path: string): void | Promise<void>}>;
    virtualViews?: Array<{ id: string; title: string; icon: string; preview?: boolean; create(container: HTMLElement): Promise<IEditor> }>;
    resolveEditor?: (node: Node) => EditorFactory | null | undefined;
    onEditorCreated?: (editor: IEditor | null) => void;
    saveDebounceMs?: number;
    files?: FileSystemContext;
    sidebarContainer?: HTMLElement;
    emptyMessage?: string;
    defaultWindowId?: string;
    workbenchState?: WorkbenchStatePort;
    windows?: import('../workbench/windows').WorkbenchWindowBinding;
    refreshFileMetadata?: boolean;
    canCreateEntries?: boolean;
    navigationLabel?: string;
    onBeforeNavigate?(): void;
    onResourceRelocated?(path: string): void;
    onResourceActivated?(path: string | null): void;
    [key: string]: any;
}
const fileOpenLog = createModuleLogger('file-window');
function logFileOpen(trace: {operationId: string; started: number}, stage: 'flush' | 'editor', failure?: {error: unknown}): void {
    const fields = {operationId: trace.operationId, stage, durationMs: Math.round(performance.now() - trace.started)};
    if (!failure) {
        fileOpenLog.debug('file.open', {...fields, result: 'success'});
        return;
    }
    const code = (failure.error as {code?: unknown})?.code;
    fileOpenLog.warn('file.open', {...fields, result: 'failure', code: typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(code)
        ? code : stage === 'flush' ? 'FILE_SAVE_FAILED' : 'FILE_EDITOR_OPEN_FAILED'});
}
interface OpenView { node: VFSNodeUI; editor?: IEditor; lease?: EditorLease; cancel?: () => void }
const replacePrefix = (path: string, old: string, next: string) => path === old || path.startsWith(old + '/') ? next + path.slice(old.length) : path;

/** Each open file owns its editor and save coordinator independently of navigation. */
export function connectEditorLifecycle(vfs: VFSUIShell, engine: IFileSystem, container: HTMLElement,
    factory?: EditorFactory, options: ConnectOptions = {}): (() => Promise<void>) & { whenReady(): Promise<void>; refreshDirectory(): Promise<void>; setVisible(visible: boolean): Promise<void>; openDirectory(path: string): Promise<void>; openResource(path: string, mode?: 'edit' | 'render'): Promise<void>; getActiveResourceId(): string | null; assertRecovery(): void; captureRecovery(): unknown; restoreRecovery(state: unknown): void; suspendForRecovery(): void } {
    const { resolveEditor, onEditorCreated, files = { fs: engine, cwd: '/' }, sidebarContainer, workbenchState, windows, emptyMessage, defaultWindowId, navigationLabel, onBeforeNavigate, saveDebounceMs: _debounce, ...extra } = options;
    if (files.fs !== engine) throw new Error('Editor file context differs from its file tree');
    const revisions = new Map<string, string | undefined>();
    const loads = new LatestViewLoad(), pending = new Set<Promise<void>>();
    let visible = true, closed = false, pendingItem: VFSNodeUI | undefined, sidebar: WorkbenchSidebar | undefined;
    const report = (error: unknown) => {
        const notice = document.createElement('p'); notice.className = 'session-detail__error'; notice.setAttribute('role', 'alert');
        notice.textContent = error instanceof Error ? error.message : String(error); tabs.content.append(notice);
    };
    const tabs = new WorkbenchTabs<OpenView>(container, {
        toggleSidebar: () => vfs.toggleSidebar(),
        navigation: navigationLabel,
        defaultWindow: defaultWindowId ? {id: defaultWindowId, title: navigationLabel ?? t('project.files')} : undefined,
        showEmpty: async () => {
            onBeforeNavigate?.(); loads.cancel();
            await openingTail; await flush(tabs.current?.value?.editor); pendingItem = undefined;
        },
        describe: async tab => ({ location: tab.id }),
        activate: async id => { if (id === '/') await openDirectory(id); else await openResource(id); }, dispose: disposeTab,
        empty: () => { placeholder(); onEditorCreated?.(null); options.onResourceActivated?.(null); }, error: report,
        changed: () => sidebar?.save(tabs.snapshot()),
    }, workbenchState?.load()?.tabs, windows);
    if (sidebarContainer) sidebar = new WorkbenchSidebar(sidebarContainer, tabs.opened, workbenchState, navigationLabel, tabs.windowManagement);
    async function flush(editor?: IEditor): Promise<void> {
        if (editor?.flushPendingSave) await editor.flushPendingSave();
        else if (editor?.isDirty?.()) throw new Error('Dirty editor does not support flushing');
    }
    let recovering = false;
    async function disposeTab(tab: WorkbenchTab<OpenView>): Promise<void> {
        const view = tab.value; if (!view) return;
        if (!recovering) await flush(view.editor);
        view.lease ??= new EditorLease(view.editor, async () => { view.cancel?.(); });
        await view.lease.dispose(recovering);
    }
    function placeholder(): void { tabs.content.textContent = emptyMessage ?? t('workbench.selectFile'); }
    let selectionWork: Promise<void> = Promise.resolve();
    function host(): EditorHostContext {
        const external = extra.hostContext as EditorHostContext | undefined;
        return { openFile: async (path, anchor) => {
                if (!await engine.driver.getNode(path)) throw new FSError('ENOENT', 'File not found', 'open', path);
                await openResource(path); await selectionWork;
                if (anchor && tabs.current?.id === path) await tabs.current.value?.editor?.navigateTo({ elementId: anchor });
            }, reloadContent: async (path, accept) => {
                let revision: string | undefined;
                const bytes = await engine.driver.readContent(path, {encoding: 'binary', onRevision: value => {revision = value;}});
                if (await accept(new TextDecoder().decode(bytes))) revisions.set(path, revision);
            }, chatFromFile: external?.chatFromFile, toggleSidebar: () => navigateWorkspaceBack(container, () => external?.toggleSidebar ? external.toggleSidebar() : vfs.toggleSidebar()),
            navigate: async (request: NavigationRequest) => { await external?.navigate?.(request); }, saveContent: persist };
    }
    async function persist(path: string, content: string): Promise<void> {
        await engine.driver.writeContent(path, content, {ifRevision: revisions.get(path), onRevision: value => {revisions.set(path, value);}});
        if (options.refreshFileMetadata === false || fileContentFormat(path, options.fileTypes).contentFormat !== 'markdown') return;
        try { const { metadata, summary } = parseFileInfo(content); await engine.driver.updateMetadata(path, { ...metadata, _summary: summary }); }
        catch (error) { console.error('[EditorConnector] Metadata refresh failed:', error); }
    }
    function bind(tab: WorkbenchTab<OpenView>, view: OpenView): void {
        tabs.bind(tab, view.editor);
        if (!view.editor?.on) return;
        tab.subscriptions.push(view.editor.on('optimisticUpdate', () => {
            const stats = extractTaskCounts(view.editor!.getText());
            vfs.updateNodeMetadata(view.node.id, { custom: { ...view.node.metadata.custom, taskCount: stats } });
        }));
    }
    async function directoryEntries(path: string) {
        const nodes = await filterGitignoredFiles(engine, await engine.driver.getChildren(path));
        return nodes.map(node => ({ id: node.path, name: node.name, type: node.type, icon: vfs.getResourceIcon(node), created: node.createdAt, modified: node.modifiedAt, size: node.type === 'file' ? node.size : undefined }));
    }
    async function createEntry(path: string, type: 'file' | 'directory'): Promise<void> {
        await showNameDialog(t(type === 'file' ? 'project.createFile' : 'project.createFolder'), t('project.newFileName'), lifetime.signal, async name => {
            if (type === 'file') await vfs.sessionService.createFile({ title: name, parentPath: path });
            else await vfs.sessionService.createDirectory({ title: name, parentPath: path });
            await vfs.refresh(); await openDirectory(path);
        });
    }
    const lifetime = new AbortController();
    async function directory(tab: WorkbenchTab<OpenView>, item: VFSNodeUI, load: ViewLoad): Promise<void> {
        tabs.setIcon(tab.id, item.icon ?? FILE_ICONS.folder);
        const nodes = await filterGitignoredFiles(engine, await engine.driver.getChildren(item.id, { signal: load.signal }), load.signal); load.check();
        const readOnly = !allowsRowAction('create-in-folder-session', extra.readOnly === true, item) || (await engine.capabilitiesAt(item.id)).readonly; load.check();
        tab.panel.replaceChildren(createDirectoryList({ title: item.metadata.title, path: item.id,
            breadcrumbs: fileDirectoryBreadcrumbs(item.id, t('project.files')),
            openDirectory: id => { void (id === '/' ? openDirectory(id).then(() => vfs.setSelection([])) : openResource(id)).catch(report); },
            entries: nodes.map(node => ({ id: node.path, name: node.name, type: node.type, icon: vfs.getResourceIcon(node), created: node.createdAt, modified: node.modifiedAt, size: node.type === 'file' ? node.size : undefined })),
            contextMenu: (event, id) => { void vfs.showItemMenu(event, id).catch(report); }, select: ids => vfs.setSelection(ids),
            selectedIds: () => vfs.getSnapshot().selectedIds,
            bulkActions: directoryBulkActions(vfs),
            actions: [...(options.directoryActions ?? []).map(action => ({...action, run: () => {void Promise.resolve().then(() => action.run(item.id)).catch(report);}})),
                ...(readOnly ? [] : [{ label: t('project.createFile'), icon: FILE_BROWSER_ICONS.addFile, disabled: options.canCreateEntries === false, run: () => { void createEntry(item.id, 'file').catch(report); } },
                    { label: t('project.createFolder'), icon: FILE_BROWSER_ICONS.addFolder, disabled: options.canCreateEntries === false, run: () => { void createEntry(item.id, 'directory').catch(report); } }])],
            open: id => { void openResource(id).catch(report); },
            parent: item.id === '/' ? undefined : () => {
                const parent = item.id.slice(0, item.id.lastIndexOf('/')) || '/';
                void (parent === '/' ? openDirectory(parent) : openResource(parent)).catch(report);
            },
            refresh: () => directoryEntries(item.id).catch(error => { report(error); throw error; }) }));
        tab.subscriptions.push(watchDirectoryList(engine, tab.panel, report, () => visible && !closed && tabs.current?.id === tab.id));
        tab.subscriptions.push(watchDirectorySelection(tab.panel, vfs));
    }
    async function create(tab: WorkbenchTab<OpenView>, item: VFSNodeUI, load: ViewLoad): Promise<void> {
        tabs.location(tab.id, item.id);
        if (item.icon) tabs.setIcon(tab.id, item.icon);
        const view: OpenView = { node: item };
        const virtual = options.virtualViews?.find(view => view.id === item.id);
        if (virtual) view.editor = await virtual.create(tab.panel);
        else if (item.type === 'directory') await directory(tab, item, load);
        else {
            const raw = await engine.driver.readContent(item.id, {encoding: 'binary', onRevision: value => {revisions.set(item.id, value);}});
            load.check(); const mime = guessMimeType('file' + (item.metadata.custom?._extension ?? ''));
            const mount = document.createElement('div'); mount.className = 'session-editor-mount'; tab.panel.replaceChildren(mount);
            if (isBinaryViewable(mime)) { const editor = new MediaViewerEditor(mime); await editor.init(mount, raw); view.editor = editor; }
            else {
                const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
                const createEditor = resolveEditor?.(item) ?? factory;
                if (!createEditor) throw new Error('No suitable editor factory found.');
                view.editor = await createRecoverableFileEditor(createEditor, mount, { ...extra, ...fileContentFormat(item.id, options.fileTypes), files, signal: load.signal,
                    mountTitleBar: (container, parts) => tabs.mountTitleBar(container, parts),
                    mountWindowList: container => tabs.mountWindowList(container),
                    target: { kind: 'file', path: item.id }, initialContent: text, title: item.metadata.title,
                    language: item.metadata.custom?._extension, hostContext: host() }, String(options.recoveryScope ?? engine.viewId));
            }
            if (!loads.isCurrent(load) || closed) { await view.editor?.destroy(); return; }
        }
        if (!loads.isCurrent(load) || closed) { await view.editor?.destroy(); return; }
        load.check(); view.cancel = loads.detach(load); tab.value = view; bind(tab, view);
    }
    let openingTail = Promise.resolve();
    function select({item}: {item?: VFSNodeUI}): Promise<void> {
        pendingItem = item;
        if (!visible || closed) return Promise.resolve();
        onBeforeNavigate?.();
        const load = loads.begin();
        if (!defaultWindowId) return openItem(item, load).catch(report);
        const work = openingTail.then(async () => {
            const finish = workbenchState?.begin?.();
            try {
                await openItem(item, load);
                if (item && !load.signal.aborted && tabs.current?.value?.node.id === item.id) options.onResourceActivated?.(item.id);
            } finally { finish?.(); }
        });
        openingTail = work.catch(() => {});
        return work;
    }
    async function openItem(item: VFSNodeUI | undefined, load: ViewLoad): Promise<void> {
        if (!loads.isCurrent(load)) return;
        const origin = tabs.current;
        const trace = {operationId: randomUUID(), started: performance.now()};
        try { await flush(origin?.value?.editor); }
        catch (error) {
            if (defaultWindowId && loads.isCurrent(load)) pendingItem = origin?.value?.node;
            logFileOpen(trace, 'flush', {error});
            throw error;
        }
        if (!loads.isCurrent(load)) return;
        if (!item) { if (!origin?.value) placeholder(); return; }
        const virtual = options.virtualViews?.find(view => view.id === item.id);
        const label = defaultWindowId && item.type === 'file' && !virtual ? fileWindowLabel(item.id) : undefined;
        if (item.type === 'file' && origin?.value?.node.type === 'directory') tabs.keep(origin.id);
        const existing = tabs.get(item.id);
        if (existing?.value) {
            tabs.activate(item.id);
            await existing.value.editor?.activate?.();
            await refreshDirectoryList(existing.panel);
            if (label && (!existing.defaultLabel || !existing.pinned)) await tabs.commitDefault(existing, label);
            onEditorCreated?.(existing.value.editor ?? null);
            return;
        }
        const tab = await tabs.open(item.id, item.metadata.title || item.id, virtual?.preview ?? true, !!label);
        const task = prepareItem(tab, item, load, trace, origin, label);
        pending.add(task); try { await task; } finally { pending.delete(task); }
    }
    async function prepareItem(tab: WorkbenchTab<OpenView>, item: VFSNodeUI, load: ViewLoad, trace: {operationId: string; started: number},
        origin?: WorkbenchTab<OpenView>, label?: string): Promise<void> {
        try {
            await create(tab, item, load);
            if (!tab.value) { await tabs.discardCandidate(tab, origin); return; }
            if (label) await tabs.commitDefault(tab, label);
            onEditorCreated?.(tab.value?.editor ?? null);
            logFileOpen(trace, 'editor');
        } catch (error) {
            const cancelled = load.signal.aborted;
            await tabs.discardCandidate(tab, origin);
            if (cancelled || closed) return;
            logFileOpen(trace, 'editor', {error});
            if (!label) tab.panel.replaceChildren();
            else if (pendingItem === item) pendingItem = origin?.value?.node;
            throw error;
        }
    }
    function relocate(oldPath: string, newPath: string): void {
        const operationId = randomUUID(), started = Date.now();
        const active = tabs.current?.id;
        let count = 0;
        for (const tab of tabs.values()) {
            const next = replacePrefix(tab.id, oldPath, newPath); if (next === tab.id) continue;
            const title = next.split('/').pop() || tab.title, view = tab.value;
            if (view) {
                Object.assign(view.node, {id: next, metadata: {...view.node.metadata, title, path: next,
                    parentPath: next.slice(0, next.lastIndexOf('/')) || '/'}});
                view.editor?.updateNodeId?.(next); view.editor?.setTitle?.(title);
                if (view.node.type === 'directory') relocateDirectoryList(tab.panel, next, title, fileDirectoryBreadcrumbs(next, t('project.files')));
            }
            revisions.set(next, revisions.get(tab.id)); revisions.delete(tab.id);
            tabs.location(tab.id, next); tabs.rename(tab.id, next, title, tab.defaultLabel ? fileWindowLabel(next) : undefined); count++;
        }
        if (pendingItem) {
            const next = replacePrefix(pendingItem.id, oldPath, newPath);
            if (next !== pendingItem.id) pendingItem = {...pendingItem, id: next};
        }
        if (count) console.debug('[EditorConnector]', {operationId, operation: 'resource.relocate', stage: 'views', result: 'success', count, durationMs: Date.now() - started});
        if (active && active !== tabs.current?.id && tabs.current) options.onResourceRelocated?.(tabs.current.id);
    }
    const unsubscribe = [vfs.on('sessionSelected', event => { selectionWork = select(event).catch(report); }),
        vfs.on('navigateToHeading', ({ elementId }) => tabs.current?.value?.editor?.navigateTo({ elementId })),
        vfs.on('fileRenamed', ({ oldId, newId }) => relocate(oldId, newId))];
    if (typeof engine.on === 'function') unsubscribe.push(engine.on('node:moved', event => {
        for (const {oldPath, newPath} of event.payload.nodes) relocate(oldPath, newPath);
    }), engine.on('node:renamed', event => {
        for (const {oldPath, newPath} of event.payload.nodes) relocate(oldPath, newPath);
    }), engine.on('node:deleted', event => {
        for (const tab of tabs.values()) if (event.payload.requestedPaths.some(path => tab.id === path || tab.id.startsWith(path + '/')))
            void tabs.close(tab.id, false).catch(report);
    }));
    placeholder();
    const dispose = async () => {
        closed = true; lifetime.abort(); loads.cancel(); unsubscribe.forEach(fn => fn()); await openingTail; await Promise.allSettled(pending);
        sidebar?.save(tabs.snapshot()); await tabs.destroy(); sidebar?.destroy();
    };
    async function openDirectory(path: string): Promise<void> {
        const node = await engine.driver.getNode(path);
        if (path !== '/' && (!node || node.type !== 'directory')) return;
        await select({ item: { id: path, type: 'directory', icon: node ? vfs.getResourceIcon(node) : FILE_ICONS.folder, version: '1', metadata: { title: node?.name || t('project.files'), path,
            parentPath: node?.parentPath ?? null, tags: [], createdAt: new Date(node?.createdAt ?? 0).toISOString(), lastModified: new Date(node?.modifiedAt ?? 0).toISOString(), custom: node?.metadata ?? {} } } });
    }
    async function openResource(path: string, mode?: 'edit' | 'render'): Promise<void> {
        const virtual = options.virtualViews?.find(view => view.id === path);
        if (virtual) {
            selectionWork = select({ item: { id: path, type: 'file', icon: virtual.icon, version: '1',
                metadata: { title: virtual.title, path, parentPath: null, tags: [], createdAt: '', lastModified: '', custom: {} } } });
            await selectionWork; return;
        }
        const node = await engine.driver.getNode(path);
        if (!node) throw new FSError('ENOENT', 'File not found', 'open', path);
        const item: VFSNodeUI = {id: path, type: node.type === 'directory' ? 'directory' : 'file', icon: vfs.getResourceIcon(node), version: String(node.version),
            metadata: {title: node.name, path, parentPath: node.parentPath, tags: [],
                createdAt: new Date(node.createdAt).toISOString(), lastModified: new Date(node.modifiedAt).toISOString(),
                custom: {...node.metadata, _extension: node.name.includes('.') ? '.' + node.name.split('.').pop() : ''}}};
        selectionWork = select({item}); await selectionWork;
        if (mode && tabs.current?.id === path) {await tabs.current.value?.editor?.switchToMode(mode); tabs.current.value?.editor?.focus();}
    }
    const refreshDirectory = async () => {if (!closed && visible && tabs.current) await refreshDirectoryList(tabs.current.panel);};
    return Object.assign(dispose, {refreshDirectory, assertRecovery: () => tabs.assertRecovery(), captureRecovery: () => tabs.captureRecovery(), restoreRecovery: (state: unknown) => tabs.restoreRecovery(state), suspendForRecovery: () => {recovering = true; tabs.suspendForRecovery();}, openDirectory, openResource, getActiveResourceId: () => tabs.current?.value?.node.id ?? null, async whenReady(): Promise<void> { await selectionWork; }, async setVisible(next: boolean): Promise<void> {
        if (visible === next) return; visible = next;
        if (!next) { loads.cancel(); await Promise.all(tabs.values().map(tab => flush(tab.value?.editor))); }
        else if (pendingItem && (tabs.current?.id !== pendingItem.id || !tabs.current?.value)) await select({ item: pendingItem });
        else {await refreshDirectory(); await tabs.current?.value?.editor?.activate?.();}
    } });
}

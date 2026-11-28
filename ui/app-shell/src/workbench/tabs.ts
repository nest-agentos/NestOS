import {TabBarViewport} from './tab-bar-viewport';
import { ACTION_ICONS, FILE_ICONS, FILE_BROWSER_ICONS, fileTypeIcon, t } from '@nestos/common';
import { decorateButton, decorateResourceButton } from './controls';
import type { IEditor } from '@nestos/ui-common-adapter';
import type { WorkbenchSnapshot } from './state';
import {navigateWorkspaceBack} from '../navigation/page-history';
import {revealWorkspaceNavigation} from '../navigation/window-navigation';
import {createModuleLogger, randomUUID} from '@nestos/common';
import {windowNavigation} from './window-navigation';
import {openedButton} from './opened-button';
import {compactNavigation} from './compact-navigation';
import {mountContentTitleBar} from './content-titlebar';
import type {ContentTitleBarParts} from '@nestos/ui-common-adapter';
import {MOBILE_NAVIGATION_QUERY} from '@nestos/ui-common-adapter';
import { Drawer, formatDisplayLabel } from '@nestos/vfs-ui';
import type {WindowManagementOptions} from '@nestos/vfs-ui';
import type { WorkbenchWindowBinding, WorkbenchWindow } from './windows';
import type { PinnedWindow, WindowTimes } from '@nestos/app-contracts/services';
import {captureEditor, restoreEditor, type EditorRecoveryState} from './recovery';

import {appendWindowTimes, compareWindows, readWindowTimes, windowTimeFields, type WindowTimeField} from './window-times';

const navigationLog = createModuleLogger('window-navigation');

interface TabsRecovery {
    tabs: NonNullable<WorkbenchSnapshot['tabs']>;
    editors: Map<string, EditorRecoveryState>;
}

export interface WorkbenchTab<T> extends WindowTimes {
    conversationId?: string;
    defaultLabel?: string;
    context?: string;
    navigationLabel?: HTMLElement;
    location?: string;
    statusIcon?: string; statusTooltip?: string;
    icon?: string;
    id: string; title: string; pinned: boolean; preview: boolean;
    dirty: boolean; failed: boolean; panel: HTMLElement; value?: T;
    subscriptions: (() => void)[];
}
interface TabActions<T> {
    toggleSidebar?(): void;
    navigation?: string;
    defaultWindow?: {id: string; title: string};
    parent?(tab: WorkbenchTab<T>): Promise<void>;
    canGoUp?(tab: WorkbenchTab<T>): boolean;
    describe?(tab: WorkbenchTab<T>): Promise<{ context?: string; location?: string }>;
    activate(id: string): Promise<void>;
    dispose(tab: WorkbenchTab<T>): Promise<void>;
    empty(): void;
    showEmpty?(): Promise<void>;
    error(error: unknown): void;
    changed?(): void;
}

/** Keeps editor DOM mounted so cursor, undo history and scroll survive switching. */
export class WorkbenchTabs<T> {
    readonly opened = document.createElement('div');
    private readonly openedDrawer = new Drawer({title: t('workbench.opened'), showHeader: false, collapsible: false,
        search: {label: t('workbench.findOpened'), mountLeading: container => {
            const home = windowNavigation({home: () => {this.closeOpenedDialog?.(); this.runNavigation('home');}});
            container.append(...home.buttons); return () => home.destroy();
        }, onChange: query => {if (this.windows) this.windows.registry.setQuery(query); else {this.openedQuery = query; this.render();}}}});
    private readonly bar = document.createElement('div');
    private readonly sidebarToggle = document.createElement('button');
    private readonly tabViewport = new TabBarViewport(this.bar);
    private readonly body = document.createElement('div');
    private readonly navigation = document.createElement('div');
    private readonly standalone: ReturnType<typeof compactNavigation>;
    private readonly emptyPanel = document.createElement('div');
    private readonly entries = new Map<string, WorkbenchTab<T>>();
    private readonly pinWrites = new WeakMap<WorkbenchTab<T>, Promise<void>>();
    private readonly candidates = new WeakSet<WorkbenchTab<T>>();
    private readonly retainedCandidates = new WeakSet<WorkbenchTab<T>>();
    private readonly closed: { id: string; title: string }[] = [];
    private readonly selected = new Set<string>();
    private readonly metadataRevisions = new WeakMap<WorkbenchTab<T>, number>();
    private currentId?: string;
    private disposing = false;
    private opening = 0;
    private activation = 0;
    private readonly closing = new Map<string, Promise<void>>();
    private readonly abort = new AbortController();
    private readonly compactViews = new Map<ReturnType<typeof compactNavigation>, HTMLElement | undefined>();
    private openedDialog?: HTMLDialogElement;
    private closeOpenedDialog?: () => void;
    private readonly windowButtons = new Set<ReturnType<typeof openedButton>>();
    private readonly barWindows = openedButton(origin => this.showOpened(origin));
    private sidebarObserver?: MutationObserver;
    private readonly windowSubscribers = new Set<() => void>();
    private readonly navigationViews = new Set<ReturnType<typeof windowNavigation>>();
    private readonly titleBars = new Set<ReturnType<typeof mountContentTitleBar>>();
    private openedQuery = '';
    private openedSort: WindowTimeField = 'accessedAt';
    private describing?: Promise<void>;
    private readonly editors = new Map<WorkbenchTab<T>, IEditor>();
    private readonly recovery = new Map<string, EditorRecoveryState>();
    private readonly recoveryFailures = new Map<string, unknown>();
    private recovering = false;
    private unregisterWindows?: () => void;
    constructor(private readonly container: HTMLElement, private readonly actions: TabActions<T>, restored?: WorkbenchSnapshot['tabs'], private readonly windows?: WorkbenchWindowBinding) {
        container.classList.add('workbench-tabs'); this.bar.className = 'workbench-tabs__bar';
        this.bar.setAttribute('role', 'tablist'); this.bar.setAttribute('aria-label', t('workbench.tabs'));
        this.body.className = 'workbench-tabs__body'; this.emptyPanel.className = 'workbench-tabs__panel';
        this.opened.className = 'workbench-tabs__opened'; this.opened.append(this.openedDrawer.element); this.body.append(this.emptyPanel);
        this.navigation.className = 'workbench-tabs__navigation';
        this.standalone = compactNavigation(this.navigation, '', () => {
            navigateWorkspaceBack(container);
        }, origin => this.showOpened(origin), this.navigationActions());
        container.append(this.navigation, this.bar, this.body);
        this.observeSidebar();
        for (const tab of restored ?? []) {
            const entry = this.create(tab.id, tab.title, false, readWindowTimes(tab)); entry.pinned = tab.pinned;
            entry.defaultLabel = tab.defaultLabel;
            entry.context = tab.context; entry.location = tab.location; entry.conversationId = tab.conversationId;
        }
        const slot = actions.defaultWindow;
        if (slot && !this.values().some(tab => tab.defaultLabel && !tab.pinned)) {
            const empty = this.get(slot.id) ?? this.create(slot.id, slot.title, false);
            this.activate(empty.id);
        }
        container.addEventListener('keydown', event => this.keydown(event), { signal: this.abort.signal });
        if (windows) this.unregisterWindows = windows.registry.register(windows.id, {items: () => this.windowItems(),
            describe: () => this.describeOpened(), reopen: () => this.reopen()}, () => this.renderShared());
        this.render();
    }
    get current(): WorkbenchTab<T> | undefined { return this.currentId ? this.entries.get(this.currentId) : undefined; }
    private observeSidebar(): void {
        const sidebar = this.container.closest('.mm-layout')?.querySelector<HTMLElement>('.mm-sidebar');
        const update = () => {this.container.dataset.sidebarVisible = String(!!sidebar && !sidebar.hidden && !sidebar.classList.contains('is-collapsed'));};
        update(); if (!sidebar) return;
        this.sidebarObserver = new MutationObserver(update);
        this.sidebarObserver.observe(sidebar, {attributes: true, attributeFilter: ['class', 'hidden']});
    }
    get windowManagement(): WindowManagementOptions {
        return {open: origin => this.showOpened(origin), count: () => this.windowCount(),
            subscribe: changed => {this.windowSubscribers.add(changed); return () => {this.windowSubscribers.delete(changed);};}};
    }
    mountTitleBar(container: HTMLElement, parts: ContentTitleBarParts = {}, back?: () => void): () => void {
        const view = mountContentTitleBar(container, parts, at => this.mountWindowList(at), back, () => {
            const tab = this.current;
            if (tab?.panel.contains(container)) this.pin(tab.id);
        });
        this.titleBars.add(view); view.update(this.titleBarState());
        return () => {this.titleBars.delete(view); view.destroy();};
    }
    private titleBarState() {
        const tab = this.current;
        return {title: tab?.title ?? '', context: tab?.context, dirty: tab?.dirty, pinned: tab?.pinned};
    }
    mountCompactNavigation(container: HTMLElement, context: string, back: () => void, label?: HTMLElement): () => void {
        const view = compactNavigation(container, context, back, origin => this.showOpened(origin), this.navigationActions());
        const anchor = document.createComment('draft title'), media = label && typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_NAVIGATION_QUERY) : undefined;
        label?.before(anchor);
        const update = () => {
            if (label && !media?.matches) anchor.after(label);
            const custom = media?.matches ? label : undefined;
            this.compactViews.set(view, custom); view.update(this.current?.title ?? '', this.windowCount(), undefined, custom, this.canGoUp());
        };
        media?.addEventListener('change', update); update();
        return () => {media?.removeEventListener('change', update); if (label) anchor.replaceWith(label);
            this.compactViews.delete(view); view.destroy();};
    }
    mountWindowList(container: HTMLElement, withNavigation = true): () => void {
        const navigation = withNavigation ? windowNavigation(this.navigationActions()) : undefined;
        if (navigation) {this.navigationViews.add(navigation); navigation.update(this.canGoUp()); container.append(...navigation.buttons);}
        const view = openedButton(origin => this.showOpened(origin)); container.append(view.button);
        this.windowButtons.add(view); view.update(this.windowCount());
        return () => {this.windowButtons.delete(view); view.destroy(); if (navigation) {this.navigationViews.delete(navigation); navigation.destroy();}};
    }
    private canGoUp(): boolean {
        const tab = this.current;
        return !!tab && !this.isEmpty(tab) && (this.actions.canGoUp?.(tab) ?? (tab.id.startsWith('/') && tab.id !== '/'));
    }
    private navigationActions() {
        return {parent: () => this.runNavigation('parent')};
    }
    private runNavigation(kind: 'home' | 'parent'): void {
        const tab = this.current;
        if (kind === 'parent' && (!tab || !this.canGoUp())) return;
        const operationId = randomUUID(), started = performance.now();
        const task = async () => {
            try {
                if (kind === 'home') {
                    if (this.windows?.showNavigation) await this.windows.showNavigation();
                    else revealWorkspaceNavigation(this.container);
                }
                else if (this.actions.parent) await this.actions.parent(tab!);
                else await this.actions.activate(tab!.id.slice(0, tab!.id.lastIndexOf('/')) || '/');
                navigationLog.debug('window.navigate', {operationId, operation: kind, stage: 'navigate', result: 'success', durationMs: Math.round(performance.now() - started)});
            } catch (error) {
                navigationLog.warn('window.navigate', {operationId, operation: kind, stage: 'navigate', result: 'failure',
                    code: String((error as {code?: string})?.code ?? 'WINDOW_NAVIGATION_FAILED'), durationMs: Math.round(performance.now() - started)});
                throw error;
            }
        };
        this.run(task());
    }
    private showOpened(origin?: HTMLElement): void {
        if (this.openedDialog?.open) return;
        this.closeOpenedDialog?.();
        origin ??= document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const dialog = document.createElement('dialog'); dialog.className = 'workbench-opened-sheet';
        dialog.setAttribute('aria-label', t('workbench.opened'));
        const heading = document.createElement('strong'); heading.textContent = t('workbench.opened');
        const close = this.button(t('action.close'), () => this.closeOpenedDialog?.());
        decorateButton(close, FILE_BROWSER_ICONS.close, t('action.close'), true);
        const header = document.createElement('div'); header.className = 'workbench-opened-sheet__header'; header.append(heading, close);
        this.mountOpenedDialog(dialog, header, origin);
        dialog.showModal();
        if (this.windows) {
            this.windows.registry.describe();
            const registry = this.windows.registry;
            this.renderShared();
            void registry.refreshPins().catch(error => registry.report(error));
        } else this.describeOpened();
    }
    private mountOpenedDialog(dialog: HTMLDialogElement, header: HTMLElement, origin?: HTMLElement): void {
        const placeholder = document.createComment('opened documents'); this.opened.before(placeholder);
        const footer = document.createElement('footer'); footer.className = 'workbench-opened-sheet__navigation';
        const panel = document.createElement('section'); panel.className = 'workbench-opened-sheet__panel';
        panel.setAttribute('aria-label', t('workbench.opened')); panel.append(header, this.opened);
        dialog.append(panel, footer); document.body.append(dialog); this.openedDialog = dialog;
        let released = false, releaseNavigation: (() => void) | undefined;
        const release = () => {
            if (released) return; released = true; releaseNavigation?.();
            this.openedDrawer.content.querySelectorAll('[data-opened-pin]').forEach(row => row.remove());
            placeholder.replaceWith(this.opened); dialog.remove(); this.openedDialog = undefined; this.closeOpenedDialog = undefined;
            const fallback = this.current?.panel.querySelector<HTMLButtonElement>('.workbench-window-list');
            (origin?.isConnected && !origin.closest('[hidden]') ? origin : fallback)?.focus();
        };
        this.closeOpenedDialog = () => {dialog.close(); release();};
        releaseNavigation = this.mountOpenedNavigation(footer, this.closeOpenedDialog);
        dialog.addEventListener('click', event => {if (event.target === dialog) this.closeOpenedDialog?.();});
        dialog.addEventListener('close', release, {once: true});
    }
    private mountOpenedNavigation(footer: HTMLElement, close: () => void): () => void {
        const media = window.matchMedia?.(MOBILE_NAVIGATION_QUERY);
        let release: (() => void) | undefined;
        const update = () => {
            release?.(); release = undefined;
            if (media?.matches) release = this.windows?.registry.mountNavigation(footer, close);
            footer.hidden = !release;
        };
        update(); media?.addEventListener('change', update);
        return () => {media?.removeEventListener('change', update); release?.();};
    }
    private describeOpened(): void {
        if (this.describing || !this.actions.describe) return;
        const tabs = this.displayed().filter(tab => !tab.location && !this.isEmpty(tab));
        this.describing = Promise.all(tabs.map(async tab => {
            const id = tab.id, revision = this.metadataRevisions.get(tab);
            try {
                const info = await this.actions.describe!(tab);
                if (!this.disposing && this.get(id) === tab && this.metadataRevisions.get(tab) === revision) {
                    Object.assign(tab, info); this.render();
                }
            } catch (error) { console.warn('[WorkbenchTabs] Reading window location failed', error); }
        })).then(() => {}).finally(() => { this.describing = undefined; });
    }
    private async activateOpened(id: string): Promise<void> {
        await this.requestActivate(id);
        document.querySelectorAll<HTMLDialogElement>('.workbench-opened-sheet[open]').forEach(dialog => dialog.close());
    }
    get content(): HTMLElement { return this.current?.panel ?? this.emptyPanel; }
    get(id: string): WorkbenchTab<T> | undefined { return this.entries.get(id); }
    private isEmpty(tab: WorkbenchTab<T>): boolean { return tab.id === this.actions.defaultWindow?.id; }
    windowId(tab: WorkbenchTab<T>): string {
        const slot = this.actions.defaultWindow;
        if (!slot || !tab.defaultLabel) return tab.id;
        const current = this.current;
        const defaultTab = this.get(slot.id) ?? (current?.defaultLabel && !current.pinned ? current
            : this.values().find(entry => entry.defaultLabel && !entry.pinned));
        if (defaultTab === tab) return slot.id;
        const base = slot.id + '-' + tab.defaultLabel.replaceAll('%', '%25').replaceAll('~', '%7E');
        const first = this.values().find(entry => entry !== defaultTab && entry.defaultLabel === tab.defaultLabel);
        return first === tab ? base : base + '~' + encodeURIComponent(tab.id);
    }
    values(): WorkbenchTab<T>[] { return [...this.entries.values()]; }
    private displayed(): WorkbenchTab<T>[] { return this.values().filter(tab => !this.candidates.has(tab)); }
    snapshot(): NonNullable<WorkbenchSnapshot['tabs']> {
        return this.displayed().filter(tab => !tab.preview && (!this.isEmpty(tab) || tab.pinned)).map(tab => this.snapshotTab(tab));
    }
    private snapshotTab({id, title, pinned, defaultLabel, conversationId, context, location, createdAt, modifiedAt, accessedAt}: WorkbenchTab<T>): NonNullable<WorkbenchSnapshot['tabs']>[number] {
        const synced = this.windows?.registry.pinned(this.windows.id, id);
        return {id, title, ...readWindowTimes({createdAt, modifiedAt, accessedAt}), pinned: pinned && (synced === undefined || !!defaultLabel),
            ...(defaultLabel ? {defaultLabel} : {}), ...(conversationId ? {conversationId} : {}), ...(context ? {context} : {}), ...(location ? {location} : {})};
    }
    async open(id: string, title: string, preview = true, candidate = false): Promise<WorkbenchTab<T>> {
        ++this.opening; this.syncViewState();
        try {
            const existing = this.get(id);
            if (existing) {
                if (candidate && !existing.value) {
                    this.candidates.add(existing);
                    this.retainedCandidates.add(existing);
                }
                this.activate(id); return existing;
            }
            const previous = !candidate && this.values().find(tab => tab.preview && !tab.defaultLabel);
            if (previous) await this.close(previous.id, false);
            const tab = this.create(id, title, preview);
            if (candidate) this.candidates.add(tab);
            this.activate(id); return tab;
        } finally { --this.opening; this.syncViewState(); }
    }
    async commitDefault(tab: WorkbenchTab<T>, label: string): Promise<void> {
        const slot = this.actions.defaultWindow;
        if (!slot) return;
        const previous = this.values().filter(entry => entry !== tab && (this.isEmpty(entry) || entry.defaultLabel));
        const stage = {operationId: randomUUID(), started: performance.now()};
        await this.defaultOperation(stage, 'replace', async () => {
            const empty = this.get(slot.id);
            await Promise.all(previous.map(entry => this.pinWrites.get(entry)?.catch(() => {})));
            const useEmpty = !!empty && !tab.pinned;
            if (useEmpty && empty.pinned) await this.savePin(tab, true);
            for (const entry of previous) {
                if (entry === empty ? useEmpty : !entry.pinned && !tab.pinned) await this.close(entry.id, false);
            }
            tab.defaultLabel = label;
            this.publishCandidate(tab);
        });
    }
    publishCandidate(tab: WorkbenchTab<T>): void {
        this.candidates.delete(tab); this.retainedCandidates.delete(tab);
        this.render(); this.tabViewport.reveal();
    }
    async discardCandidate(tab: WorkbenchTab<T>, origin?: WorkbenchTab<T>): Promise<boolean> {
        if (!this.candidates.has(tab)) return false;
        if (this.retainedCandidates.has(tab)) await this.resetCandidate(tab);
        else await this.close(tab.id, false);
        if (origin && this.get(origin.id) === origin) this.activate(origin.id);
        return true;
    }
    private async resetCandidate(tab: WorkbenchTab<T>): Promise<void> {
        await this.actions.dispose(tab);
        this.editors.delete(tab);
        tab.subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
        tab.panel.replaceChildren();
        tab.value = undefined;
        tab.dirty = tab.failed = false;
        this.publishCandidate(tab);
    }
    private async defaultOperation<TValue>(trace: {operationId: string; started: number}, stage: string, work: () => TValue | Promise<TValue>): Promise<TValue> {
        const fields = {operationId: trace.operationId, stage};
        try {
            const value = await work();
            navigationLog.debug('window.default', {...fields, result: 'success', durationMs: Math.round(performance.now() - trace.started)});
            return value;
        } catch (error) {
            const code = (error as {code?: unknown})?.code;
            navigationLog.warn('window.default', {...fields, result: 'failure', durationMs: Math.round(performance.now() - trace.started),
                code: typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,79}$/.test(code) ? code : 'WINDOW_UPDATE_FAILED'});
            throw error;
        }
    }
    private create(id: string, title: string, preview: boolean, times?: WindowTimes): WorkbenchTab<T> {
        const panel = document.createElement('div'); panel.className = 'workbench-tabs__panel'; panel.hidden = true;
        const now = Date.now();
        const tab: WorkbenchTab<T> = { ...(times ?? {createdAt: now, modifiedAt: now}), id, title, preview, pinned: false, dirty: false, failed: false, panel, subscriptions: [] };
        this.entries.set(id, tab); this.body.append(panel); return tab;
    }
    activate(id: string): void {
        this.container.dataset.workbenchActivation = String(++this.activation);
        const tab = this.get(id);
        if (tab) tab.accessedAt = Date.now();
        this.currentId = id; this.emptyPanel.hidden = true;
        for (const tab of this.values()) tab.panel.hidden = tab.id !== id;
        this.render(); this.tabViewport.reveal();
    }
    keep(id: string): void { const tab = this.get(id); if (tab) { tab.preview = false; this.render(); } }
    pin(id: string): void {
        const tab = this.get(id); if (!tab || this.candidates.has(tab)) return;
        const work = this.savePin(tab, !tab.pinned);
        this.run(work);
    }
    private savePin(tab: WorkbenchTab<T>, pinned: boolean): Promise<void> {
        const pending = this.pinWrites.get(tab);
        if (pending) return pending;
        const {id} = tab;
        const saved = this.windows && !this.isEmpty(tab) && !id.startsWith('draft:') && this.windows.registry.setPin({
            workspace: this.windows.id, resource: id, title: tab.title,
            scope: this.actions.navigation, context: tab.context, location: tab.location, ...readWindowTimes(tab),
        }, pinned);
        if (!saved) {
            this.applyPin(tab, pinned); this.keep(id);
            return Promise.resolve();
        }
        this.keep(id);
        const work = saved.finally(() => {if (this.pinWrites.get(tab) === work) this.pinWrites.delete(tab);});
        this.pinWrites.set(tab, work);
        return work;
    }
    private applyPin(tab: WorkbenchTab<T>, pinned: boolean): void {
        tab.pinned = pinned;
        if (pinned) {tab.preview = false; this.selected.delete(tab.id);}
    }
    private syncPins(): void {
        if (!this.windows) return;
        const {id, registry} = this.windows;
        for (const tab of this.values()) {
            if (this.isEmpty(tab) || tab.id.startsWith('draft:')) continue;
            const pinned = registry.pinned(id, tab.id);
            if (pinned !== undefined) this.applyPin(tab, pinned);
        }
    }
    title(id: string, title: string): void { const tab = this.get(id); if (tab && tab.title !== title) { tab.title = title; tab.modifiedAt = Date.now(); this.render(); } }
    context(id: string, context?: string): void { this.updateMetadata(id, 'context', context); }
    setNavigationLabel(id: string, label: HTMLElement): void {
        const tab = this.get(id); if (tab) { tab.navigationLabel = label; this.render(); }
    }
    location(id: string, location: string): void { this.updateMetadata(id, 'location', location); }
    private updateMetadata(id: string, field: 'context' | 'location', value?: string): void {
        const tab = this.get(id);
        if (!tab || tab[field] === value) return;
        tab[field] = value;
        this.metadataRevisions.set(tab, (this.metadataRevisions.get(tab) ?? 0) + 1);
        this.render();
    }
    setIcon(id: string, icon: string): void { const tab = this.get(id); if (tab) { tab.icon = icon; this.render(); } }
    setStatus(id: string, icon: string, tooltip: string): void {
        const tab = this.get(id);
        if (!tab || tab.statusIcon === icon && tab.statusTooltip === tooltip) return;
        tab.statusIcon = icon; tab.statusTooltip = tooltip; this.render();
    }
    rename(id: string, next: string, title: string, defaultLabel?: string): void {
        const tab = this.get(id); if (!tab) return;
        if (next !== id && this.get(next)) throw new Error(`Tab already open: ${next}`);
        this.metadataRevisions.set(tab, (this.metadataRevisions.get(tab) ?? 0) + 1);
        const entries = [...this.entries].map(([key, value]) => [key === id ? next : key, value] as const);
        if (defaultLabel) tab.defaultLabel = defaultLabel;
        tab.id = next; tab.title = title; tab.modifiedAt = Date.now(); this.entries.clear(); for (const [key, value] of entries) this.entries.set(key, value);
        if (next !== id && this.recovery.has(id)) {this.recovery.set(next, this.recovery.get(id)!); this.recovery.delete(id);}
        if (next !== id && this.recoveryFailures.has(id)) {this.recoveryFailures.set(next, this.recoveryFailures.get(id)); this.recoveryFailures.delete(id);}
        if (this.selected.delete(id)) this.selected.add(next);
        if (this.currentId === id) this.currentId = next;
        this.render();
        if (id !== next && tab.defaultLabel) this.relocatePin(tab, id);
    }
    private relocatePin(tab: WorkbenchTab<T>, oldResource: string): void {
        const binding = this.windows;
        if (!binding) return;
        const bookmark = {workspace: binding.id, resource: tab.id, title: tab.title, scope: this.actions.navigation,
            context: tab.context, location: tab.location, ...readWindowTimes(tab)};
        const previous = this.pinWrites.get(tab);
        const move = async () => {
            await previous?.catch(() => {});
            if (!binding.registry.pinned(binding.id, oldResource)) return;
            await binding.registry.setPin(bookmark, true);
            await binding.registry.setPin({...bookmark, resource: oldResource}, false);
        };
        const work = move().finally(() => {if (this.pinWrites.get(tab) === work) this.pinWrites.delete(tab);});
        this.pinWrites.set(tab, work);
        this.run(work);
    }
    bind(tab: WorkbenchTab<T>, editor?: IEditor): void {
        if (editor) {
            this.editors.set(tab, editor);
            this.restoreEditorState(tab, editor);
        }
        if (!editor?.on) return;
        tab.subscriptions.push(editor.on('interactiveChange', () => {
            tab.preview = false; tab.dirty = true; this.render();
        }), editor.on('saved', () => { tab.modifiedAt = Date.now(); tab.dirty = false; tab.failed = false; this.render(); }),
        editor.on('saveError', error => { tab.preview = false; tab.dirty = true; tab.failed = true; this.render(); this.actions.error(error); }));
    }
    private restoreEditorState(tab: WorkbenchTab<T>, editor: IEditor): void {
        const state = this.recovery.get(tab.id);
        if (!state) return;
        try {
            restoreEditor(editor, tab.panel, state); this.recovery.delete(tab.id); this.recoveryFailures.delete(tab.id);
        } catch (error) {this.recoveryFailures.set(tab.id, error); throw error;}
    }
    captureRecovery(): TabsRecovery {
        if (this.isOpening()) throw Object.assign(new Error(t('httpApp.recoveryBusy')), {code: 'RECOVERY_BUSY'});
        const editors = new Map(this.recovery);
        for (const [tab, editor] of this.editors) if (!editors.has(tab.id)) editors.set(tab.id, captureEditor(editor, tab.panel));
        return {tabs: this.values().map(tab => this.snapshotTab(tab)), editors};
    }
    restoreRecovery(snapshot: unknown): void {
        const state = snapshot as TabsRecovery;
        for (const item of state.tabs) {
            const tab = this.get(item.id) ?? this.create(item.id, item.title, false, readWindowTimes(item));
            Object.assign(tab, item);
        }
        for (const [id, editor] of state.editors) this.recovery.set(id, editor);
        for (const [tab, editor] of this.editors) this.restoreEditorState(tab, editor);
        this.render();
    }
    suspendForRecovery(): void { this.recovering = true; for (const editor of this.editors.values()) editor.suspendForRecovery?.(); }
    assertRecovery(): void {
        if (!this.current || !this.recovery.has(this.current.id)) return;
        if (this.recoveryFailures.has(this.current.id)) throw this.recoveryFailures.get(this.current.id);
        throw Object.assign(new Error(t('httpApp.recoveryRestorePending')), {code: 'RECOVERY_RESTORE_INCOMPLETE'});
    }
    close(id: string, record = true): Promise<void> {
        const pending = this.closing.get(id); if (pending) return pending;
        const task = this.closeNow(id, record).finally(() => this.closing.delete(id));
        this.closing.set(id, task); return task;
    }
    private async closeNow(id: string, record: boolean): Promise<void> {
        const tab = this.get(id); if (!tab) return;
        try { await this.actions.dispose(tab); }
        catch (error) { if (!this.recovering) {tab.preview = false; tab.failed = true; this.render(); throw error;} }
        this.windows?.registry.rememberPinTimes(this.windows.id, tab.id, readWindowTimes(tab));
        tab.subscriptions.forEach(unsubscribe => unsubscribe()); tab.panel.remove(); this.entries.delete(tab.id);
        this.editors.delete(tab); this.recovery.delete(tab.id);
        this.recoveryFailures.delete(tab.id);
        this.selected.delete(tab.id);
        if (record && !tab.preview && !this.isEmpty(tab)) { this.closed.push({ id: tab.id, title: tab.title }); this.windows?.registry.noteClosed(this.windows.id); }
        if (this.currentId === tab.id) {
            this.currentId = undefined; this.emptyPanel.hidden = false;
            if (record) await this.activateAfterClose();
        }
        if (record && !this.values().some(entry => this.isEmpty(entry) || entry.defaultLabel && !entry.pinned)) {
            const slot = this.actions.defaultWindow;
            if (slot) this.create(slot.id, slot.title, false);
        }
        this.render();
    }
    private async activateAfterClose(): Promise<void> {
        const next = this.displayed().at(-1);
        if (next && !this.isEmpty(next)) {await this.actions.activate(next.id); return;}
        if (next) this.activate(next.id);
        this.actions.empty();
    }
    private run(task: Promise<unknown>): void { void task.catch(error => {this.windows?.registry.report(error); this.actions.error(error);}); }
    private button(label: string, action: () => void, className = ''): HTMLButtonElement {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.className = className; button.title = label; button.setAttribute('aria-label', label); button.onclick = action; return button;
    }
    private render(): void {
        this.renderShared();
        if (!this.disposing) { this.actions.changed?.(); this.windows?.registry.changed(); }
    }
    private renderShared(): void {
        this.syncPins();
        this.syncViewState();
        this.standalone.update(this.current?.title ?? '', this.windowCount(), this.current?.context, this.current?.navigationLabel, this.canGoUp());
        for (const view of this.titleBars) view.update(this.titleBarState());
        for (const view of this.navigationViews) view.update(this.canGoUp());
        for (const view of this.windowButtons) view.update(this.windowCount());
        for (const changed of this.windowSubscribers) changed();
        for (const [view, label] of this.compactViews) view.update(this.current?.title ?? '', this.windowCount(), undefined, label, this.canGoUp());
        this.bar.replaceChildren(); this.openedDrawer.content.replaceChildren();
        this.sidebarToggle.type = 'button'; this.sidebarToggle.className = 'workbench-tabs__sidebar-toggle';
        this.sidebarToggle.innerHTML = ACTION_ICONS.sidebar; this.sidebarToggle.title = t('workspace.sidebar.toggle');
        this.sidebarToggle.setAttribute('aria-label', this.sidebarToggle.title);
        this.sidebarToggle.onclick = () => {
            if (this.actions.toggleSidebar) this.actions.toggleSidebar();
            else this.container.closest('.mm-layout')?.querySelector('.mm-sidebar')?.classList.toggle('is-collapsed');
        };
        this.bar.append(this.sidebarToggle);
        if (this.windows?.registry.error) {
            const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.className = 'workbench-tabs__error';
            notice.textContent = this.windows.registry.error; notice.append(this.button(t('action.close'), () => this.windows?.registry.clearError()));
            this.openedDrawer.content.append(notice);
        }
        const toolbar = this.openedToolbar();
        toolbar.append(this.openedSortControl());
        this.appendOpenedActions(toolbar);
        this.openedDrawer.content.append(toolbar);
        if (this.windows) this.renderWindows();
        else {
            const tabs = this.displayed().sort((a, b) => Number(b.pinned) - Number(a.pinned));
            for (const tab of tabs) this.bar.append(this.tabHeader(tab));
            tabs.sort((a, b) => compareWindows(a, b, this.openedSort));
            for (const tab of tabs) this.openedDrawer.content.append(this.openedRow(tab));
            this.filterOpened();
        }
        this.barWindows.button.classList.add('workbench-tabs__bar-windows');
        this.barWindows.update(this.windowCount()); this.bar.append(this.barWindows.button);
        this.tabViewport.update();
    }
    private openedSortControl(): HTMLSelectElement {
        const select = document.createElement('select');
        select.setAttribute('aria-label', t('workbench.sortOpened'));
        for (const field of windowTimeFields) {
            const option = document.createElement('option');
            option.value = field; option.textContent = t(`workbench.${field}`);
            select.append(option);
        }
        select.value = this.windows?.registry.sort ?? this.openedSort;
        select.onchange = () => {
            const field = windowTimeFields.find(value => value === select.value);
            if (!field) return;
            if (this.windows) this.windows.registry.setSort(field);
            else {this.openedSort = field; this.renderShared();}
            if (this.openedDialog?.open) this.openedDrawer.content.querySelector('select')?.focus();
        };
        return select;
    }
    private appendOpenedActions(toolbar: HTMLElement): void {
        const actions = document.createElement('div'); actions.className = 'workbench-tabs__opened-actions';
        const reopen = this.button(t('workbench.reopen'), () => this.run(this.windows?.registry.reopen() ?? this.reopen()), 'ui-nav-button');
        reopen.dataset.action = 'reopen-tab'; decorateButton(reopen, FILE_BROWSER_ICONS.reopen, t('workbench.reopen'), true);
        const saved = this.button(t('workbench.closeSaved'), () => this.run(this.windows?.registry.closeSaved() ?? this.closeSaved()), 'ui-nav-button');
        saved.dataset.action = 'close-saved-tabs'; decorateButton(saved, FILE_BROWSER_ICONS.closeSaved, t('workbench.closeSaved'), true);
        const close = toolbar.querySelector<HTMLButtonElement>('[data-action=close-selected-tabs]')!; close.classList.add('ui-nav-button');
        actions.append(reopen, saved, close); toolbar.append(actions);
    }
    private windowCount(): number { return this.windows?.registry.items().length ?? this.displayed().length; }
    private isCurrent(id: string): boolean { return id === this.currentId && (!this.windows || this.windows.isActive()); }
    private requestActivate(id: string): Promise<void> {
        const tab = this.get(id);
        if (tab && this.isEmpty(tab)) return this.activateEmpty(tab);
        return this.windows && !this.windows.isActive() ? this.windows.navigate(id) : this.actions.activate(id);
    }
    private async activateEmpty(tab: WorkbenchTab<T>): Promise<void> {
        if (this.windows && !this.windows.isActive()) await this.windows.showNavigation?.();
        if (this.current === tab) return;
        await this.actions.showEmpty?.();
        if (this.get(tab.id) !== tab) return;
        this.activate(tab.id);
        this.actions.empty();
    }
    private windowItems(): WorkbenchWindow[] {
        this.syncPins();
        return this.displayed().map(tab => ({id: this.windowId(tab), resource: tab.id, workspace: this.windows?.id, title: tab.title, scope: this.actions.navigation,
            ...readWindowTimes(tab), context: tab.context, location: tab.location, pinned: tab.pinned, dirty: tab.dirty, failed: tab.failed,
            selected: this.selected.has(tab.id), active: this.isCurrent(tab.id), activate: () => this.requestActivate(tab.id), header: () => this.tabHeader(tab), row: () => this.openedRow(tab),
            select: selected => { if (selected) this.selected.add(tab.id); else this.selected.delete(tab.id); },
            close: () => this.close(tab.id)}));
    }
    private renderWindows(): void {
        const registry = this.windows!.registry;
        this.openedDrawer.setQuery(registry.query);
        const items = registry.items();
        for (const item of items) this.bar.append(item.header());
        const pins = this.openedDialog ? registry.unopenedPins(items) : [];
        const rows = [...items, ...pins.map(pin => ({...pin, pinned: true, row: () => this.pinnedRow(pin)}))];
        rows.sort((a, b) => compareWindows(a, b, registry.sort));
        for (const item of rows) {
            const row = item.row(); row.hidden = !registry.matches(item);
            this.openedDrawer.content.append(row);
        }
    }
    private pinnedRow(window: PinnedWindow): HTMLElement {
        const registry = this.windows!.registry;
        const row = document.createElement('div'); row.className = 'workbench-tabs__opened-row';
        row.dataset.openedPin = window.resource; row.hidden = !registry.matches(window);
        const label = this.button(window.title, () => this.run(registry.openPin(window).then(() => this.closeOpenedDialog?.())), 'workbench-tabs__opened-label');
        decorateResourceButton(label, fileTypeIcon(window.title), window.title);
        this.openedLabel(label, window);
        const pin = this.button(t('workbench.unpin'), () => this.run(registry.setPin(window, false) ?? Promise.resolve()), 'workbench-tabs__opened-pin');
        decorateButton(pin, FILE_ICONS.pin, t('workbench.unpin'), true); pin.setAttribute('aria-pressed', 'true');
        row.append(label, pin);
        return row;
    }
    private sharedOpenedToolbar(): HTMLElement {
        const registry = this.windows!.registry, eligible = registry.items().filter(item => !item.pinned && registry.matches(item));
        const bar = document.createElement('div'); bar.className = 'workbench-tabs__opened-toolbar';
        const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', t('workbench.selectAllOpened'));
        all.checked = !!eligible.length && eligible.every(item => item.selected);
        all.indeterminate = !all.checked && eligible.some(item => item.selected); all.disabled = !eligible.length;
        all.onchange = () => registry.selectAll(all.checked);
        const label = document.createElement('label'); label.append(all, document.createTextNode(t('workbench.selectAllOpened')));
        const close = this.button(t('workbench.closeSelected'), () => this.run(registry.closeSelected()));
        close.dataset.action = 'close-selected-tabs'; const count = registry.items().filter(item => item.selected).length;
        decorateButton(close, FILE_BROWSER_ICONS.close, `${t('workbench.closeSelected')} (${count})`, true); close.disabled = !count;
        bar.append(label, close); return bar;
    }
    private tabHeader(tab: WorkbenchTab<T>): HTMLElement {
        const header = document.createElement('div'); header.className = 'workbench-tabs__tab'; header.dataset.tabId = this.windowId(tab); header.dataset.resource = tab.id;
        header.classList.toggle('is-active', this.isCurrent(tab.id)); header.classList.toggle('is-preview', tab.preview);
        const label = this.button(tab.title, () => this.run(this.requestActivate(tab.id)), 'workbench-tabs__label');
        label.setAttribute('role', 'tab'); label.setAttribute('aria-selected', String(this.isCurrent(tab.id)));
        decorateResourceButton(label, tab.icon ?? fileTypeIcon(tab.title), tab.title);
        label.title = [tab.title, tab.statusTooltip].filter(Boolean).join('\n'); label.ondblclick = () => this.keep(tab.id);
        const state = document.createElement('span'); state.className = 'workbench-tabs__state';
        state.title = tab.failed ? t('workbench.saveFailed') : tab.dirty ? t('workbench.pending') : tab.preview ? t('workbench.preview') : '';
        state.textContent = tab.failed ? '!' : tab.dirty ? '•' : '';
        state.setAttribute('aria-label', state.title);
        if (tab.statusIcon) {
            const status = document.createElement('span'); status.className = 'workbench-tabs__state';
            status.textContent = tab.statusIcon; status.title = tab.statusTooltip ?? ''; status.setAttribute('aria-label', status.title); header.append(status);
        }
        if (tab.context) header.append(this.contextLabel(tab.context));
        header.append(label, state, this.button(t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), () => this.pin(tab.id), 'workbench-tabs__pin'),
            this.button(t('workbench.close'), () => this.run(this.close(tab.id)), 'workbench-tabs__close'));
        decorateButton(header.querySelector<HTMLButtonElement>('.workbench-tabs__close')!, FILE_BROWSER_ICONS.close, t('workbench.close'), true);
        const pin = header.querySelector<HTMLButtonElement>('.workbench-tabs__pin')!;
        decorateButton(pin, FILE_ICONS.pin, t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), true); pin.setAttribute('aria-pressed', String(tab.pinned));
        if (tab.preview) header.append(decorateButton(this.button(t('workbench.keep'), () => this.keep(tab.id), 'workbench-tabs__keep'), FILE_BROWSER_ICONS.keep, t('workbench.keep'), true));
        return header;
    }
    private openedRow(tab: WorkbenchTab<T>): HTMLElement {
        const row = document.createElement('div'); row.className = 'workbench-tabs__opened-row'; row.dataset.openedId = this.windowId(tab); row.dataset.resource = tab.id;
        row.classList.toggle('is-active', this.isCurrent(tab.id));
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(tab.id); checkbox.disabled = tab.pinned;
        checkbox.setAttribute('aria-label', `${t('workbench.select')} ${tab.title}`);
        checkbox.onchange = () => { checkbox.checked ? this.selected.add(tab.id) : this.selected.delete(tab.id); this.render(); };
        const label = this.button(tab.title, () => this.run(this.activateOpened(tab.id))); label.title = tab.id;
        decorateResourceButton(label, tab.icon ?? fileTypeIcon(tab.title), tab.title); label.className = 'workbench-tabs__opened-label'; label.title = tab.id;
        this.openedLabel(label, {...tab, scope: this.actions.navigation});
        label.setAttribute('aria-current', String(this.isCurrent(tab.id)));
        const pin = decorateButton(this.button(t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), () => this.pin(tab.id)), FILE_ICONS.pin, t(tab.pinned ? 'workbench.unpin' : 'workbench.pin'), true);
        pin.className = 'workbench-tabs__opened-pin'; pin.setAttribute('aria-pressed', String(tab.pinned));
        row.append(checkbox);
        row.append(label, pin, decorateButton(this.button(t('workbench.close'), () => this.run(this.close(tab.id))), FILE_BROWSER_ICONS.close, t('workbench.close'), true)); return row;
    }
    private openedLabel(label: HTMLButtonElement, tab: Pick<PinnedWindow, 'title' | 'scope' | 'context' | 'location'> & WindowTimes): void {
        const text = label.lastElementChild!; text.className = 'workbench-tabs__opened-text';
        const title = document.createElement('span'); title.textContent = formatDisplayLabel(tab.title); title.title = tab.title; text.replaceChildren(title);
        label.title = tab.title; label.setAttribute('aria-label', tab.title);
        const context = [tab.scope, tab.context, tab.location].filter(Boolean).join(' · ');
        if (context) {
            const location = document.createElement('small'); location.textContent = context; text.append(location);
            label.title = `${tab.title} — ${context}`; label.setAttribute('aria-label', `${tab.title} — ${context}`);
        }
        appendWindowTimes(text, readWindowTimes(tab));
    }
    private filterOpened(): void {
        for (const row of this.opened.querySelectorAll<HTMLElement>('[data-opened-id]')) {
            const tab = this.get(row.dataset.resource!);
            row.hidden = !tab || !this.matchesOpened(tab);
        }
    }
    private matchesOpened(tab: WorkbenchTab<T>): boolean {
        return [this.actions.navigation, tab.title, tab.context, tab.location].filter(Boolean).join('\n')
            .toLocaleLowerCase().includes(this.openedQuery.trim().toLocaleLowerCase());
    }
    private contextLabel(context: string): HTMLElement {
        const label = document.createElement('span'); label.className = 'workbench-tabs__context';
        label.textContent = context; label.title = context; return label;
    }
    private isOpening(): boolean { return this.opening > 0 || !!this.current && this.candidates.has(this.current); }
    private syncViewState(): void {
        this.container.dataset.workbenchView = this.isOpening() ? 'opening' : this.current && !this.isEmpty(this.current) ? 'active' : 'empty';
    }
    private openedToolbar(): HTMLElement {
        if (this.windows) return this.sharedOpenedToolbar();
        const bar = document.createElement('div'); bar.className = 'workbench-tabs__opened-toolbar';
        const all = document.createElement('input'); all.type = 'checkbox'; all.setAttribute('aria-label', t('workbench.selectAllOpened'));
        const eligible = this.values().filter(tab => !tab.pinned && this.matchesOpened(tab));
        all.checked = eligible.length > 0 && eligible.every(tab => this.selected.has(tab.id));
        all.indeterminate = !all.checked && eligible.some(tab => this.selected.has(tab.id)); all.disabled = !eligible.length;
        all.onchange = () => { eligible.forEach(tab => {if (all.checked) this.selected.add(tab.id); else this.selected.delete(tab.id);}); this.render(); };
        const label = document.createElement('label'); label.append(all, document.createTextNode(t('workbench.selectAllOpened')));
        const close = this.button(t('workbench.closeSelected'), () => this.run(this.closeSelected())); close.dataset.action = 'close-selected-tabs';
        decorateButton(close, FILE_BROWSER_ICONS.close, `${t('workbench.closeSelected')} (${this.selected.size})`, true); close.disabled = !this.selected.size;
        bar.append(label, close); return bar;
    }
    private async closeSelected(): Promise<void> {
        let failure: unknown;
        for (const id of [...this.selected]) if (!this.get(id)?.pinned) {
            try { await this.close(id); } catch (error) { failure = error; }
        }
        if (failure) throw failure;
    }
    private async closeSaved(): Promise<void> {
        for (const tab of this.displayed()) if (!tab.pinned && !tab.dirty && !tab.failed) await this.close(tab.id);
    }
    private async reopen(): Promise<void> {
        const tab = this.closed.pop(); if (!tab) return;
        await this.requestActivate(tab.id); this.keep(tab.id);
    }
    private keydown(event: KeyboardEvent): void {
        if (!(event.ctrlKey || event.metaKey)) return;
        if (event.key === 'Tab') {
            event.preventDefault();
            if (this.windows) {this.run(this.windows.registry.cycle(event.shiftKey ? -1 : 1)); return;}
            const tabs = this.displayed(), index = tabs.findIndex(tab => tab.id === this.currentId);
            const next = tabs[(index + (event.shiftKey ? tabs.length - 1 : 1)) % tabs.length];
            if (next) this.run(this.requestActivate(next.id));
        } else if (event.shiftKey && event.key.toLowerCase() === 't') {
            event.preventDefault(); this.run(this.windows?.registry.reopen() ?? this.reopen());
        }
    }
    async destroy(): Promise<void> {
        this.sidebarObserver?.disconnect(); this.barWindows.destroy();
        this.closeOpenedDialog?.();
        this.unregisterWindows?.(); this.unregisterWindows = undefined;
        this.disposing = true; this.tabViewport.destroy();
        for (const tab of this.values()) await this.close(tab.id, false);
        for (const view of this.windowButtons) view.destroy(); this.windowButtons.clear(); this.windowSubscribers.clear();
        for (const view of this.navigationViews) view.destroy(); this.navigationViews.clear();
        for (const view of this.titleBars) view.destroy(); this.titleBars.clear();
        this.abort.abort(); this.openedDrawer.destroy(); this.standalone.destroy(); this.navigation.remove(); this.bar.remove(); this.body.remove(); this.opened.remove(); this.container.classList.remove('workbench-tabs');
        delete this.container.dataset.workbenchView;
        delete this.container.dataset.workbenchActivation;
        delete this.container.dataset.sidebarVisible;
    }
}

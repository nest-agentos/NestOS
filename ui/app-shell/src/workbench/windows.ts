import type {WindowTimeField} from './window-times';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {PinnedWindow, PinnedWindowChange, WindowTimes} from '@nestos/app-contracts/services';

const log = createModuleLogger('workbench-windows');
/** Application-owned window metadata; editor instances remain in their workspace. */
export interface WorkbenchWindow extends WindowTimes {
    id: string; resource?: string; workspace?: string; title: string; scope?: string; context?: string; location?: string;
    active: boolean;
    activate(): Promise<void>;
    pinned: boolean; dirty: boolean; failed: boolean; selected: boolean;
    header(): HTMLElement; row(): HTMLElement;
    select(selected: boolean): void;
    close(): Promise<void>;
}
interface WindowSource {
    items(): WorkbenchWindow[];
    describe(): void;
    reopen(): Promise<void>;
}
export interface WorkbenchWindowBinding {
    registry: WorkbenchWindows;
    id: string;
    isActive(): boolean;
    navigate(id: string): Promise<void>;
    showNavigation?(): Promise<void>;
}

interface PinnedWindowPort {
    list(): Promise<PinnedWindow[]>;
    set(change: PinnedWindowChange): Promise<void>;
    navigate(window: PinnedWindow): Promise<void>;
}
const pinKey = (workspace: string, resource: string) => JSON.stringify([workspace, resource]);

export class WorkbenchWindows {
    constructor(private readonly navigationMount?:(container:HTMLElement,close:()=>void)=>(()=>void)|undefined,
        private readonly bookmarks?: PinnedWindowPort) {}
    mountNavigation(container:HTMLElement,close:()=>void):(()=>void)|undefined {return this.navigationMount?.(container,close);}
    private readonly sources = new Map<string, {source: WindowSource; render(): void}>();
    private readonly closed: string[] = [];
    private pins = new Map<string, PinnedWindow>();
    private readonly closedPinTimes = new Map<string, WindowTimes>();
    private readonly knownPins = new Set<string>();
    private readonly pendingPins = new Set<string>();
    private pinQueue = Promise.resolve();
    private pinRead?: Promise<void>;
    query = '';
    sort: WindowTimeField = 'accessedAt';
    setSort(sort: WindowTimeField): void {this.sort = sort; this.changed();}
    error?: string;
    report(error: unknown): void {this.error = error instanceof Error ? error.message : String(error); this.changed();}
    clearError(): void {this.error = undefined; this.changed();}
    register(id: string, source: WindowSource, render: () => void): () => void {
        if (this.sources.has(id)) throw new Error(`Window source already registered: ${id}`);
        this.sources.set(id, {source, render}); this.changed();
        return () => { this.sources.delete(id); this.changed(); };
    }
    items(): WorkbenchWindow[] { return [...this.sources.values()].flatMap(entry => entry.source.items()).sort((a, b) => Number(b.pinned) - Number(a.pinned)); }
    matches(item: Pick<WorkbenchWindow, 'scope' | 'title' | 'context' | 'location'>): boolean {
        const text = [item.scope, item.title, item.context, item.location].filter(Boolean).join(' ').toLocaleLowerCase();
        return this.query.trim().toLocaleLowerCase().split(/\s+/).every(term => text.includes(term));
    }
    setQuery(query: string): void { this.query = query; this.changed(); }
    changed(): void { for (const entry of this.sources.values()) entry.render(); }
    pinned(workspace: string, resource: string): boolean | undefined {
        if (!this.knownPins.size) return;
        const key = pinKey(workspace, resource);
        if (this.knownPins.has(key)) return this.pins.has(key);
    }
    unopenedPins(items: WorkbenchWindow[]): PinnedWindow[] {
        const open = new Set(items.map(item => pinKey(item.workspace ?? '', item.resource ?? item.id)));
        return [...this.pins].filter(([key]) => !open.has(key))
            .map(([key, window]) => ({...window, ...this.closedPinTimes.get(key)}));
    }
    rememberPinTimes(workspace: string, resource: string, times: WindowTimes): void {
        const key = pinKey(workspace, resource);
        if (this.pins.has(key)) this.closedPinTimes.set(key, times);
    }
    openPin(window: PinnedWindow): Promise<void> {return this.bookmarks!.navigate(window);}
    refreshPins(): Promise<void> {
        if (!this.bookmarks) return Promise.resolve();
        return this.pinRead ??= this.queuePins('read', randomUUID(), async () => {
            const windows = await this.bookmarks!.list();
            this.pins = new Map(windows.map(window => [pinKey(window.workspace, window.resource), window]));
            for (const key of this.closedPinTimes.keys()) if (!this.pins.has(key)) this.closedPinTimes.delete(key);
            for (const key of this.pins.keys()) this.knownPins.add(key);
            this.changed();
        }).finally(() => {this.pinRead = undefined;});
    }
    setPin(window: PinnedWindow, pinned: boolean): Promise<void> | undefined {
        if (!this.bookmarks) return;
        const key = pinKey(window.workspace, window.resource);
        if (this.pendingPins.has(key)) return Promise.resolve();
        const operationId = randomUUID();
        this.pendingPins.add(key);
        return this.queuePins('write', operationId, async () => {
            await this.bookmarks!.set({operationId, window, pinned});
            if (pinned) this.pins.set(key, window); else this.pins.delete(key);
            this.closedPinTimes.delete(key);
            this.knownPins.add(key);
            this.changed();
        }).finally(() => {this.pendingPins.delete(key);});
    }
    private queuePins(stage: string, operationId: string, work: () => Promise<void>): Promise<void> {
        const started = performance.now();
        const next = this.pinQueue.then(work);
        this.pinQueue = next.catch(() => {});
        return next.then(() => {
            log.debug('windows.pins', {operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
        }, error => {
            log.warn('windows.pins', {operationId, stage, result: 'failure', code: (error as {code?: string})?.code ?? 'PIN_REQUEST_FAILED',
                durationMs: Math.round(performance.now() - started)});
            throw error;
        });
    }
    describe(): void { for (const entry of this.sources.values()) entry.source.describe(); }
    selectAll(selected: boolean): void {
        for (const item of this.items()) if (!item.pinned && this.matches(item)) item.select(selected);
        this.changed();
    }
    async closeSelected(): Promise<void> { await this.close(this.items().filter(item => item.selected && !item.pinned)); }
    async closeSaved(): Promise<void> { await this.close(this.items().filter(item => !item.pinned && !item.dirty && !item.failed)); }
    private async close(items: WorkbenchWindow[]): Promise<void> {
        const started = performance.now(), operationId = randomUUID(); let failure: unknown;
        for (const item of items) { try { await item.close(); } catch (error) { failure ??= error; } }
        log.debug('windows.close', {operation: 'windows.close', operationId, stage: 'dispose', result: failure ? 'failure' : 'success',
            code: failure ? String((failure as {code?: string}).code ?? 'WINDOW_CLOSE_FAILED') : undefined, count: items.length, durationMs: Math.round(performance.now() - started)});
        if (failure) {this.report(failure); throw failure;}
    }
    async cycle(step: number): Promise<void> {
        const items = this.items(), index = items.findIndex(item => item.active);
        await items[(index + step + items.length) % items.length]?.activate();
    }
    noteClosed(id: string): void { this.closed.push(id); }
    async reopen(): Promise<void> {
        const id = this.closed.pop(); if (id) await this.sources.get(id)?.source.reopen();
    }
}

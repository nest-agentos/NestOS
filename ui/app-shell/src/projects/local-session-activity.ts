import {createModuleLogger, randomUUID} from '@nestos/common';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {KernelViewPort, SessionActivity} from '@nestos/durable-kernel/contracts';
import type {VFSNodeUI, VFSUIShell} from '@nestos/vfs-ui';
import {localSessionStatus} from './local-session-status';

const log = createModuleLogger('workbench-activity');
type ActivitySnapshot = Record<string, SessionActivity | null>;
type ReadActivity = (ids: string[]) => Promise<ActivitySnapshot | undefined>;

/** Project loaded row metadata only; never writes VFS or reloads the directory tree. */
export class LocalSessionActivityView {
    private readonly dirty = new Map<string, Set<string>>();
    private tail = Promise.resolve();
    private retryTimer?: ReturnType<typeof setTimeout>;
    private retryDelay = 1000;
    private closed = false;
    constructor(private readonly kernel: KernelViewPort, private readonly ui: () => VFSUIShell | undefined,
        private readonly visible: () => boolean, private readonly sessionPath: (id: string) => Promise<string>,
        private readonly retry?: () => void, private readonly navigationRoots?: () => readonly string[]) {}
    invalidate(sessionId: string, taskId?: string): void {
        const tasks = this.dirty.get(sessionId) ?? new Set<string>(); if (taskId) tasks.add(taskId); this.dirty.set(sessionId, tasks);
    }
    refresh(read?: ReadActivity): Promise<void> {
        this.tail = this.tail.catch(() => {}).then(() => this.refreshNow(read)); return this.tail;
    }
    private async refreshNow(read?: ReadActivity): Promise<void> {
        if (this.closed || !this.visible()) return;
        if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = undefined;
        const pending = [...this.dirty]; this.dirty.clear();
        let snapshot: ActivitySnapshot | undefined;
        if (read) {
            try {snapshot = await read(pending.filter(([id]) => !!this.loadedPath(id)).map(([id]) => id));}
            catch (error) {for (const [id, tasks] of pending) this.retain(id, tasks); throw error;}
        }
        let failed = false;
        for (const [id, tasks] of pending) {
            if (!this.visible()) {this.retain(id, tasks); continue;}
            const started = performance.now(), operationId = randomUUID();
            try {await this.project(id, tasks, snapshot);}
            catch (error) {
                if (!missingActivityResource(error)) {failed = true; this.retain(id, tasks);}
                log.warn('session.activity', {operationId, stage: 'project', outcome: 'error', sessionId: id,
                durationMs: Math.round(performance.now() - started), errorType: (error as {code?: string})?.code ?? 'ACTIVITY_READ_FAILED'});}
        }
        if (failed) this.scheduleRetry(); else this.retryDelay = 1000;
    }
    close(): void {this.closed = true; if (this.retryTimer) clearTimeout(this.retryTimer); this.dirty.clear();}
    private scheduleRetry(): void {
        if (this.closed || !this.retry || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {this.retryTimer = undefined; if (!this.closed && this.visible()) this.retry?.();}, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15000);
    }
    private loadedPath(id: string): string | undefined {
        const ui = this.ui();
        return ui?.getNode && this.navigationRoots ? loadedSessionPath(ui, loadedNodes(ui, this.navigationRoots()), id) : undefined;
    }
    private async project(id: string, tasks: Set<string>, snapshot?: ActivitySnapshot): Promise<void> {
        const ui = this.ui(); if (!ui?.getNode || !this.kernel.sessionActivity) return;
        const loaded = this.navigationRoots && loadedNodes(ui, this.navigationRoots());
        const path = loaded ? loadedSessionPath(ui, loaded, id) : await this.sessionPath(id);
        if (!path) return;
        const nodes = loaded ?? loadedNodes(ui, [path, path + '/tasks']);
        const sessions = nodes.filter(node => sessionNode(node, id));
        const activity = sessions.length ? (snapshot && Object.hasOwn(snapshot, id) ? snapshot[id] : await this.kernel.sessionActivity(id)) : undefined;
        if (!this.visible()) {this.retain(id, tasks); return;}
        if (activity) for (const node of sessions) updateActivity(ui, node, activity);
        for (const taskId of tasks) {
            const taskNode = nodes.find(node => node.id === `${path}/tasks/${taskId}`);
            if (!taskNode) continue;
            let task;
            try {task = await this.kernel.task(id, taskId);}
            catch (error) {if (missingActivityResource(error)) continue; throw error;}
            if (!this.visible() || this.closed) {this.retain(id, tasks); return;}
            ui.updateNodeMetadata(taskNode.id, {title: `${task.program.kind} · ${task.status} · ${task.id}`,
                lastModified: new Date(task.updatedAt).toISOString()});
        }
        const directory = path + '/tasks';
        if (ui.getSnapshot?.().expandedIds.includes(directory) && (!tasks.size || [...tasks].some(task => !ui.getNode(`${directory}/${task}`))))
            await ui.loadDirectory(directory);
    }
    private retain(id: string, tasks: Set<string>): void {
        this.invalidate(id); for (const task of tasks) this.invalidate(id, task);
    }
}

function missingActivityResource(error: unknown): boolean {
    return ['ENOENT', 'SESSION_NOT_FOUND', 'TASK_NOT_FOUND'].includes(String((error as {code?: unknown})?.code));
}

function loadedNodes(ui: VFSUIShell, paths: readonly string[]): VFSNodeUI[] {
    const roots = new Set([...paths, ...(ui.getSnapshot?.().expandedIds ?? [])]);
    for (const path of [...roots])
        for (let index = path.lastIndexOf('/'); index > 0; index = path.lastIndexOf('/', index - 1)) roots.add(path.slice(0, index));
    const nodes = new Map<string, VFSNodeUI>();
    const visit = (node?: VFSNodeUI) => {if (!node || nodes.has(node.id)) return; nodes.set(node.id, node); node.children?.forEach(visit);};
    for (const root of roots) visit(ui.getNode(root));
    return [...nodes.values()];
}
function loadedSessionPath(ui: VFSUIShell, nodes: VFSNodeUI[], id: string): string | undefined {
    const row = nodes.find(node => sessionNode(node, id));
    if (row) return String(row.metadata.custom.navigationTarget ?? row.id);
    const taskDirectory = ui.getSnapshot?.().expandedIds.find(path => {
        try {const target = resolveBrowserTarget(path); return target.kind === 'tasks' && target.sessionId === id;}
        catch {return false;}
    });
    return taskDirectory?.slice(0, -'/tasks'.length);
}
function sessionNode(node: VFSNodeUI, sessionId: string): boolean {
    try {const target = resolveBrowserTarget(String(node.metadata.custom.navigationTarget ?? node.id));
        return target.kind === 'session' && target.sessionId === sessionId;}
    catch {return false;}
}
function updateActivity(ui: VFSUIShell, node: VFSNodeUI, activity: SessionActivity): void {
    const old = node.metadata.custom.sessionActivity, modified = activity.latestExit?.at;
    const lastModified = modified && modified > Date.parse(node.metadata.lastModified) ? new Date(modified).toISOString() : node.metadata.lastModified;
    if (JSON.stringify(localSessionStatus(old)) === JSON.stringify(localSessionStatus(activity)) && lastModified === node.metadata.lastModified) return;
    ui.updateNodeMetadata(node.id, {lastModified, custom: {...node.metadata.custom, sessionActivity: activity}});
}

export interface ActionSnapshot {
    time: number;
    vfs: Record<string, number>;
    sidecar: Record<string, number>;
    ipc: Record<string, number>;
}

function difference(before: Record<string, number>, after: Record<string, number>) {
    const delta: Record<string, number> = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const value = (after[key] ?? 0) - (before[key] ?? 0);
        if (!Number.isFinite(value) || value < 0) throw new Error(`Trace counter reset or invalid: ${key}`);
        if (value > 0) delta[key] = value;
    }
    return delta;
}
const total = (values: Record<string, number>) => Object.values(values).reduce((sum, value) => sum + value, 0);

/** Caller-defined boundaries; elapsed time uses a monotonic host clock. */
export function createActionMetrics(snapshot: () => ActionSnapshot) {
    const active = new Map<number, { label: string; start: ActionSnapshot }>();
    let sequence = 0, stopped = false;
    return {
        begin(label: string) {
            if (stopped) throw new Error('Trace stopped');
            const id = ++sequence;
            active.set(id, { label, start: structuredClone(snapshot()) });
            return id;
        },
        end(id: number) {
            const entry = active.get(id);
            if (!entry) throw new Error('Unknown trace action');
            active.delete(id);
            const end = snapshot(), elapsedMs = end.time - entry.start.time;
            if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid trace clock');
            const delta = difference(entry.start.vfs, end.vfs);
            const sidecar = difference(entry.start.sidecar, end.sidecar);
            const ipc = difference(entry.start.ipc, end.ipc);
            return { kind: 'action' as const, id, label: entry.label, elapsedMs,
                ops: total(delta), delta, sidecarOps: total(sidecar), sidecar, ipcOps: total(ipc), ipc };
        },
        stop() { stopped = true; active.clear(); },
    };
}

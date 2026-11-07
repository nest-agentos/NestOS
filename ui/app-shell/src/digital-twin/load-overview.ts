import type { TwinWorkbenchOptions } from './index';
import type {TwinViewRequest} from '@nestos/app-contracts/services';

/** Trace names and timings only; never include source contents or model credentials. */
export function loadOverview(options: TwinWorkbenchOptions, signal: AbortSignal, request?: TwinViewRequest) {
    const started = Date.now(), pending = new Map<string, { stage: string; since: number }>();
    const durations: Array<{ stage: string; milliseconds: number }> = [];
    const stage = (key: string, name: string) => {
        const previous = pending.get(key);
        if (previous) durations.push({ stage: previous.stage, milliseconds: Date.now() - previous.since });
        pending.set(key, { stage: name, since: Date.now() });
    };
    const read = async <T>(key: string, action: () => Promise<T>): Promise<T> => {
        stage(key, key);
        const result = await action();
        stage(key, 'completed'); pending.delete(key); return result;
    };
    const diagnostic = () => ({ elapsedMs: Date.now() - started, ...options.service.diagnostics(),
        pending: [...pending.values()].map(item => ({ stage: item.stage, milliseconds: Date.now() - item.since })), completed: [...durations] });
    const configuration = !request || request.page === 'sources';
    return bounded(() => Promise.all([
        read('snapshot', () => request && options.service.readView ? options.service.readView(request) : options.service.snapshot(name => stage('snapshot', name))),
        read('connections.list', () => configuration ? options.connections() : Promise.resolve([])),
        read('scanner.targets', () => configuration ? (options.service.scannerTargets?.() ?? Promise.resolve([])) : Promise.resolve([])),
        read('twin.workspaces', () => options.service.workspaces?.() ?? Promise.resolve([])),
        read('collection.tools', () => configuration ? (options.service.collectionTools?.() ?? Promise.resolve([])) : Promise.resolve([])),
        read('source.connections', () => configuration ? (options.service.listSourceConnections?.() ?? Promise.resolve({types: [], connections: []})) : Promise.resolve({types: [], connections: []})),
        read('scanner.packages', () => configuration ? (options.packages?.list() ?? Promise.resolve([])) : Promise.resolve([])),
        read('scanner.projects', () => configuration ? (options.projects?.() ?? Promise.resolve([])) : Promise.resolve([])),
    ]), signal, diagnostic);
}

/** A view timeout does not cancel background scans or durable writes. */
function bounded<T>(read: () => Promise<T>, signal: AbortSignal, diagnostic: () => unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); clearTimeout(slow); signal.removeEventListener('abort', abort); };
        const abort = () => { finish(); reject(new Error('TWIN_LOAD_CANCELLED')); };
        const slow = setTimeout(() => console.warn('[DigitalTwin] Slow overview load', diagnostic()), 5_000);
        const timer = setTimeout(() => {
            console.error('[DigitalTwin] Overview load timed out', diagnostic());
            finish(); reject(new Error('TWIN_LOAD_TIMEOUT'));
        }, 30_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        Promise.resolve().then(read).then(resolve, error => {
            console.error('[DigitalTwin] Overview load failed', diagnostic()); reject(error);
        }).finally(finish);
    });
}

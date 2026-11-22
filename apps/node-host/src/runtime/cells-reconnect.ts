import {randomUUID} from 'node:crypto';
import {createModuleLogger} from '@nestos/common';
import type {ProjectRemoteMountPort} from '@nestos/app-contracts/services';

const log = createModuleLogger('cells-reconnect');
const intervalMs = 60_000;

export function startCellsReconnect(remote: ProjectRemoteMountPort): () => Promise<void> {
    const controller = new AbortController();
    const {signal} = controller;
    let timer: NodeJS.Timeout;
    let running: Promise<void> | undefined;
    const schedule = (delay: number) => {
        if (signal.aborted) return;
        timer = setTimeout(() => {
            running = poll(remote, signal).finally(() => { running = undefined; schedule(intervalMs); });
        }, delay).unref();
    };
    schedule(5_000);
    return async () => {
        controller.abort();
        clearTimeout(timer);
        await running;
    };
}

async function poll(remote: ProjectRemoteMountPort, signal: AbortSignal): Promise<void> {
    try {
        for (const {id, protocol} of remote.connections()) {
            if (signal.aborted) break;
            if (protocol === 'webdav' || remote.connectionStatus(id) === 'checking') continue;
            await check(remote, id, signal);
        }
    } catch (error) {
        log.warn('cells.reconnect.catalog.failed', {operation: 'cells.reconnect', stage: 'catalog', result: 'failure',
            operationId: randomUUID(), code: (error as {code?: string})?.code ?? 'CELLS_CATALOG_FAILED'});
    }
}

async function check(remote: ProjectRemoteMountPort, connectionId: string, signal: AbortSignal): Promise<void> {
    const started = performance.now(), operationId = randomUUID();
    const context = {operation: 'cells.reconnect', stage: 'check', connectionId, operationId};
    try {
        await remote.checkConnection(connectionId, {signal, timeoutMs: 3_000});
        if (signal.aborted) return;
        const status = remote.connectionStatus(connectionId);
        log.info('cells.reconnect.checked', {...context, result: status === 'online' ? 'success' : 'failure', status,
            durationMs: Math.round(performance.now() - started)});
    } catch (error) {
        if (!signal.aborted) log.warn('cells.reconnect.failed', {...context, result: 'failure',
            code: (error as {code?: string})?.code ?? 'CELLS_CHECK_FAILED', durationMs: Math.round(performance.now() - started)});
    }
}

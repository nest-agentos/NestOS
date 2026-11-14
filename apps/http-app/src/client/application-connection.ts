import {randomUUID} from '@nestos/common/startup';
import {PreparedHttpBootstrap, SnapshotCache, RPC_VERSION} from '@nestos/app-transport/http/startup';
import {setFileRecoveryOwner} from '@nestos/app-shell/startup';
import {BrowserRequestTrace} from './request-trace';
import {ConnectionStatus, type ConnectionState} from './connection-status';
import {resolveUser} from './identity';
import {initialView} from './initial-view';
export type {ConnectionState} from './connection-status';

/** Start authenticated data transfer independently of the UI and RPC implementation. */
export function connectApplication() {
    const listeners = new AbortController(), status = new ConnectionStatus(), route = initialView(location.hash);
    const tracing = new BrowserRequestTrace(); tracing.bindNavigation(listeners.signal);
    const identity = resolveUser(listeners.signal);
    const fetcher = tracing.wrap(authenticatedFetch(identity));
    const clientId = randomUUID();
    let live: ReturnType<typeof import('./live-connection').adoptConnection> | undefined;
    const preparing = identity.then(userId => {
        listeners.signal.throwIfAborted(); setFileRecoveryOwner(userId);
        const key = `mindos.snapshot-cache.v${RPC_VERSION}:${userId}`;
        const snapshots = new SnapshotCache({read: () => sessionStorage.getItem(key), write: value => sessionStorage.setItem(key, value)});
        const prepared = new PreparedHttpBootstrap({clientId, fetcher, snapshots, initialView: route.request, initialRead: route.initialRead});
        tracing.bootstrap(prepared.packet); return prepared;
    });
    const ready = Promise.all([preparing, import('./live-connection')]).then(([prepared, module]) => {
        listeners.signal.throwIfAborted(); live = module.adoptConnection(prepared, fetcher, status, listeners.signal);
        return live.ready;
    }).then(root => {performance.mark('nestos:data-ready'); return root;});
    let closing: Promise<void> | undefined;
    return {ready, editor: route.editor, subscribeStatus: (listener: (state: ConnectionState) => void) => status.subscribe(listener),
        close: () => closing ??= (async () => {
            listeners.abort(); status.close();
            if (live) await live.close(); else await preparing.then(prepared => prepared.close(), () => {});
        })()};
}
export type ApplicationConnection = ReturnType<typeof connectApplication>;

function authenticatedFetch(identity: Promise<string>): typeof fetch {
    return async (input, init) => {
        const userId = await identity, headers = new Headers(init?.headers); headers.set('X-NestOS-User', userId);
        return globalThis.fetch(input, {...init, headers});
    };
}

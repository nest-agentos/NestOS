import {HttpViewClient, ViewExpiredError, createSessionRecoveryClient} from '@nestos/app-transport/http';
import type {PreparedHttpBootstrap} from '@nestos/app-transport/http/startup';
import {withSessionRecovery} from './session-recovery';
import type {ConnectionStatus} from './connection-status';

const sessionRecoveryRequests = new Map<string, string>();
/** Adopt the original bootstrap identity and install live behavior after code arrives. */
export function adoptConnection(prepared: PreparedHttpBootstrap, fetcher: typeof fetch, status: ConnectionStatus, signal: AbortSignal) {
    const client = new HttpViewClient(prepared.options.clientId, prepared.url, fetcher,
        error => status.publish(error instanceof ViewExpiredError ? 'expired' : 'reconnecting'),
        () => status.publish('view-error'), () => status.publish('connected'));
    for (const event of ['online', 'focus', 'nestos:http-retry', 'pageshow'])
        window.addEventListener(event, () => client.retryConnection(), {signal});
    document.addEventListener('visibilitychange', () => {if (!document.hidden) client.retryConnection();}, {signal});
    const ready = client.start({prepared}).then(root => withSessionRecovery(root, createSessionRecoveryClient(fetcher), sessionRecoveryRequests));
    return {ready, close: () => client.close()};
}

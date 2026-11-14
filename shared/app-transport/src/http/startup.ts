import type {OpenViewRequest, StartupReadRequest} from '@nestos/app-contracts/services';
import type {Reply} from '../rpc/protocol';
import {RPC_VERSION} from '../rpc/protocol';
import {SnapshotCache} from './snapshot-cache';

export {SnapshotCache};
export {RPC_VERSION} from '../rpc/protocol';
export interface BootstrapPreparation {
    clientId: string;
    url?: string;
    fetcher?: typeof fetch;
    snapshots?: SnapshotCache;
    initialView?: OpenViewRequest;
    initialRead?: StartupReadRequest;
}

/** Transfer data before loading RPC projections; one live client adopts the same operation. */
export class PreparedHttpBootstrap {
    readonly url: string;
    readonly snapshots: SnapshotCache;
    readonly packet: Promise<Reply>;
    private readonly abort = new AbortController();
    private readonly fetcher: typeof fetch;
    private claimed = false;
    private started = false;
    private disposed = false;
    private closing?: Promise<void>;
    constructor(readonly options: BootstrapPreparation) {
        this.url = options.url ?? '/api/application';
        this.snapshots = options.snapshots ?? new SnapshotCache();
        this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
        this.packet = this.prepare();
        void this.packet.catch(() => {});
    }
    private async prepare(): Promise<Reply> {
        await this.snapshots.load();
        if (this.disposed) this.abort.abort();
        this.abort.signal.throwIfAborted();
        this.started = true;
        return this.post({kind: 'bootstrap', initialView: this.options.initialView,
            initialRead: this.options.initialRead, knownSnapshots: this.snapshots.known()}, this.abort.signal);
    }
    claim(clientId: string, url: string, signal: AbortSignal): Promise<Reply> {
        if (this.claimed || this.closing || clientId !== this.options.clientId || url !== this.url)
            throw Object.assign(new Error('Prepared bootstrap cannot be adopted'), {code: 'BOOTSTRAP_ADOPTION_INVALID'});
        this.claimed = true;
        const cancel = () => this.abort.abort();
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, {once: true});
        void this.packet.then(() => signal.removeEventListener('abort', cancel), () => signal.removeEventListener('abort', cancel));
        return this.packet;
    }
    close(): Promise<void> {return this.closing ??= this.release();}
    private async release(): Promise<void> {
        if (this.claimed) return;
        this.disposed = true;
        if (!this.started) this.abort.abort();
        const timer = setTimeout(() => this.abort.abort(), 5000);
        try {await this.packet.catch(() => {});} finally {clearTimeout(timer); this.abort.abort();}
        if (this.started) await this.post({kind: 'close'}, AbortSignal.timeout(5000));
    }
    private async post(body: object, signal: AbortSignal): Promise<Reply> {
        const response = await this.fetcher(this.url, {method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({...body, clientId: this.options.clientId, version: RPC_VERSION}), signal}).catch(error => {
            if (signal.aborted) throw error;
            throw Object.assign(new Error('Application startup connection interrupted'), {code:'HTTP_CONNECTION_LOST',stage:'transport.fetch'});
        });
        const reply = await response.json().catch(error => {
            if (signal.aborted) throw error;
            throw Object.assign(new Error('Invalid application startup response'), {code: 'BOOTSTRAP_RESPONSE_INVALID', stage: 'decode'});
        }) as Reply;
        if (!reply || typeof reply !== 'object' || Array.isArray(reply))
            throw Object.assign(new Error('Invalid application startup response'), {code:'BOOTSTRAP_RESPONSE_INVALID',stage:'decode'});
        if (!response.ok || reply.error) throw Object.assign(new Error(reply.error?.message ?? 'View request failed'), reply.error);
        return reply;
    }
}

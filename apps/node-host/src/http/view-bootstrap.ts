import {FSError} from '@nestos/vfs-core';
import {SnapshotCache} from '@nestos/app-transport/http';
import type {Reply, WireValue} from '@nestos/app-transport/rpc';
import type {RpcPeer} from '@nestos/app-transport/application';
import type {OpenViewRequest,StartupReadRequest} from '@nestos/app-contracts/services';
import type {HostedView} from './view-services';
import type {ViewNotifications} from './view-notifications';

export interface BootstrapClient {
    peer: RpcPeer; view: HostedView; notifications: ViewNotifications; initialized: boolean;
    bootstrap?: Promise<Reply>; stopObservation?: () => void;
    catalogs?: Promise<{updates: WireValue[]}>;
}
export interface BootstrapRequest {initialView?: OpenViewRequest; initialRead?: StartupReadRequest; knownSnapshots?: string[]; deferCatalogs?: boolean;}

const catalogMethods = ['listAgents', 'getDefaultAgents', 'getDefaultConnections', 'getProviders', 'getProviderReferences',
    'getProviderDefaults', 'getPricingConfig', 'getPricingDefaults'];
const deferredCatalogs = new Map([
    ['IAgentManagementService', new Set(catalogMethods)],
    ['IConnectionService', new Set(catalogMethods)],
    ['IToolService', new Set(['getToolDefinitions', 'listTools'])],
]);

/** Establish the target and observation before exposing the first client capability graph. */
export async function bootstrapView(client: BootstrapClient, request: BootstrapRequest, cache: SnapshotCache): Promise<object> {
    if (client.bootstrap) throw new FSError('EBUSY', 'Application view is already initialized');
    client.bootstrap = prepareBootstrap(client, request);
    const reply = await client.bootstrap;
    client.initialized = true;
    return request.knownSnapshots ? cache.pack(reply as unknown as WireValue, request.knownSnapshots) : reply;
}
async function prepareBootstrap(client: BootstrapClient, {initialView: request, initialRead: read, deferCatalogs}: BootstrapRequest): Promise<Reply> {
    const [initialView,initialRead]=await Promise.all([request?client.view.root.backend.openView(request):undefined,read?client.view.root.backend.readStartup?.(read):undefined]);
    if (initialView) client.stopObservation = await initialView.observation.observeView(initialView.cursor, event => client.notifications.enqueueView(event));
    const deferred = deferCatalogs === true && !!initialView?.conversationWorkbench?.native;
    if (deferred) client.peer.deferSnapshots(deferredCatalogs);
    return client.peer.bootstrap({...client.view.root, ...(initialView ? {initialView} : {}),...(initialRead?{initialRead}:{}),
        ...(deferred ? {deferredCatalogs: true} : {})});
}

export function bootstrapCatalogs(client: BootstrapClient): Promise<{updates: WireValue[]}> {
    return client.catalogs ??= client.peer.refreshDeferredSnapshots().then(updates => ({updates})).catch(error => {
        client.catalogs = undefined; throw error;
    });
}

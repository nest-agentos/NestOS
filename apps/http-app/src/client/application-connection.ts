import {randomUUID} from '@nestos/common/startup';
import {PreparedHttpBootstrap, SnapshotCache, RPC_VERSION} from '@nestos/app-transport/http/startup';
import {setFileRecoveryOwner} from '@nestos/app-shell/startup';
import {BrowserRequestTrace} from './request-trace';
import {ConnectionStatus, type ConnectionState} from './connection-status';
import {acceptAuthenticatedUser, authenticatedUserHint, rememberAuthenticatedUser, resolveUser} from './identity';
import {initialView} from './initial-view';
export type {ConnectionState} from './connection-status';

/** Start authenticated data transfer independently of the UI and RPC implementation. */
export function connectApplication() {
    const listeners = new AbortController(), status = new ConnectionStatus(), route = initialView(location.hash);
    const tracing = new BrowserRequestTrace(); tracing.bindNavigation(listeners.signal);
    const deferEvents=!!route.initialRead?.task || route.deferEvents;
    let verifiedUser: string | undefined;
    const pinUser=(userId:string)=>{verifiedUser=userId;setFileRecoveryOwner(userId);tracing.restore(userId);};
    const hint = deferEvents ? authenticatedUserHint() : undefined;
    const identity=deferEvents?undefined:resolveUser(listeners.signal);
    const fetcher=tracing.wrap(identity?authenticatedFetch(identity):authenticatedStartupFetch(pinUser,hint));
    const clientId = randomUUID();
    let live: ReturnType<typeof import('./live-connection').adoptConnection> | undefined;
    const preparing = Promise.resolve(identity).then(userId => {
        listeners.signal.throwIfAborted();
        if (userId) {pinUser(userId); rememberAuthenticatedUser(userId);}
        const snapshots = userId || deferEvents ? authenticatedSnapshots(() => userId ?? hint, () => verifiedUser) : undefined;
        const prepared = new PreparedHttpBootstrap({clientId, fetcher, snapshots, initialView: route.request,
            initialRead: route.initialRead, deferCatalogs: route.deferCatalogs});
        tracing.bootstrap(prepared.packet); return prepared;
    });
    const ready = Promise.all([preparing, import('./live-connection')]).then(([prepared, module]) => {
        listeners.signal.throwIfAborted();
        live = module.adoptConnection(prepared, fetcher, status, listeners.signal, {
            compatibility: error => tracing.compatibility(error),
            updateFailure: error => tracing.viewUpdateFailure(clientId, error),
        }, deferEvents);
        return live.ready;
    }).then(root => {
        const report = root.backend.reportClientDiagnostic?.bind(root.backend);
        if(report&&!deferEvents)tracing.setReporter(report);
        performance.mark('nestos:data-ready'); return root;
    });
    let closing: Promise<void> | undefined;
    const startDeferredEvents=deferEvents?async()=>{
        const root=await ready;
        const report=root.backend.reportClientDiagnostic?.bind(root.backend);
        if(report)tracing.setReporter(report);
        await live!.startEvents();
    }:undefined;
    const prepareCatalogs = () => ready.then(root => root.deferredCatalogs ? live!.prepareCatalogs() : undefined);
    return {ready, editor: route.editor, startDeferredEvents, prepareCatalogs, subscribeStatus: (listener: (state: ConnectionState) => void) => status.subscribe(listener),
        close: () => closing ??= (async () => {
            listeners.abort(); status.close();
            if (live) await live.close(); else await preparing.then(prepared => prepared.close(), () => {});
        })()};
}
export type ApplicationConnection = ReturnType<typeof connectApplication>;

function authenticatedSnapshots(readUser:()=>string|undefined, writeUser:()=>string|undefined):SnapshotCache {
    const key=(userId:string)=>`mindos.snapshot-cache.v${RPC_VERSION}:${userId}`;
    return new SnapshotCache({read:()=>{const user=readUser(); return user ? sessionStorage.getItem(key(user)) : null;},
        write:value=>{const user=writeUser(); if (user) sessionStorage.setItem(key(user),value);}});
}
export function authenticatedStartupFetch(pinUser:(id:string)=>void, hint?:string):typeof fetch {
    let userId:string|undefined;
    return async(input,init)=>{
        const headers=new Headers(init?.headers);
        const expected=userId??hint;
        if(expected)headers.set('X-NestOS-User',expected);
        const response=await globalThis.fetch(input,{...init,headers,redirect:'error'});
        if(!userId&&response.ok){
            const authenticated=response.headers.get('X-NestOS-Authenticated-User');
            if (hint && authenticated !== hint) {
                rememberAuthenticatedUser();
                throw Object.assign(new Error('Certificate user changed; reload this page'),{code:'STARTUP_USER_CHANGED'});
            }
            userId=acceptAuthenticatedUser(authenticated);
            rememberAuthenticatedUser(userId); pinUser(userId);
        }
        if (!userId && hint && response.status === 403) rememberAuthenticatedUser();
        return response;
    };
}

function authenticatedFetch(identity: Promise<string>): typeof fetch {
    return async (input, init) => {
        const userId = await identity, headers = new Headers(init?.headers); headers.set('X-NestOS-User', userId);
        return globalThis.fetch(input, {...init, headers});
    };
}

import {randomUUID} from '@nestos/common/startup';
import {PreparedHttpBootstrap, SnapshotCache, RPC_VERSION} from '@nestos/app-transport/http/startup';
import {setFileRecoveryOwner} from '@nestos/app-shell/startup';
import {BrowserRequestTrace} from './request-trace';
import {ConnectionStatus, type ConnectionState} from './connection-status';
import {acceptAuthenticatedUser,resolveUser} from './identity';
import {initialView} from './initial-view';
export type {ConnectionState} from './connection-status';

/** Start authenticated data transfer independently of the UI and RPC implementation. */
export function connectApplication() {
    const listeners = new AbortController(), status = new ConnectionStatus(), route = initialView(location.hash);
    const tracing = new BrowserRequestTrace(); tracing.bindNavigation(listeners.signal);
    const deferEvents=!!route.initialRead?.task || route.nativeConversation;
    const pinUser=(userId:string)=>{setFileRecoveryOwner(userId);tracing.restore(userId);};
    const identity=deferEvents?undefined:resolveUser(listeners.signal);
    const fetcher=tracing.wrap(identity?authenticatedFetch(identity):authenticatedStartupFetch(pinUser));
    const clientId = randomUUID();
    let live: ReturnType<typeof import('./live-connection').adoptConnection> | undefined;
    const preparing = Promise.resolve(identity).then(userId => {
        listeners.signal.throwIfAborted();
        const snapshots=userId?authenticatedSnapshots(userId,pinUser):undefined;
        const prepared = new PreparedHttpBootstrap({clientId, fetcher, snapshots, initialView: route.request, initialRead: route.initialRead});
        tracing.bootstrap(prepared.packet); return prepared;
    });
    const ready = Promise.all([preparing, import('./live-connection')]).then(([prepared, module]) => {
        listeners.signal.throwIfAborted(); live = module.adoptConnection(prepared, fetcher, status, listeners.signal,error=>tracing.compatibility(error),deferEvents);
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
    return {ready, editor: route.editor, startDeferredEvents, subscribeStatus: (listener: (state: ConnectionState) => void) => status.subscribe(listener),
        close: () => closing ??= (async () => {
            listeners.abort(); status.close();
            if (live) await live.close(); else await preparing.then(prepared => prepared.close(), () => {});
        })()};
}
export type ApplicationConnection = ReturnType<typeof connectApplication>;

function authenticatedSnapshots(userId:string,pinUser:(id:string)=>void):SnapshotCache {
    pinUser(userId);
    const key=`mindos.snapshot-cache.v${RPC_VERSION}:${userId}`;
    return new SnapshotCache({read:()=>sessionStorage.getItem(key),write:value=>sessionStorage.setItem(key,value)});
}
function authenticatedStartupFetch(pinUser:(id:string)=>void):typeof fetch {
    let userId:string|undefined;
    return async(input,init)=>{
        const headers=new Headers(init?.headers);
        if(userId)headers.set('X-NestOS-User',userId);
        const response=await globalThis.fetch(input,{...init,headers,redirect:'error'});
        if(!userId&&response.ok){
            userId=acceptAuthenticatedUser(response.headers.get('X-NestOS-Authenticated-User'));
            pinUser(userId);
        }
        return response;
    };
}

function authenticatedFetch(identity: Promise<string>): typeof fetch {
    return async (input, init) => {
        const userId = await identity, headers = new Headers(init?.headers); headers.set('X-NestOS-User', userId);
        return globalThis.fetch(input, {...init, headers});
    };
}

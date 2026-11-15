import {createModuleLogger, randomUUID, NAVIGATION_EVENTS} from '@nestos/common/startup';
import type {ClientDiagnostic} from '@nestos/app-contracts/services';
import {RequestDiagnostics, requestMetadata, responseMetadata} from './request-diagnostics';
const log = createModuleLogger('http-client');
const traceId = () => randomUUID().replaceAll('-', '');
/** A navigation owns a trace; each fetch captures its own immutable child span. */
export class BrowserRequestTrace {
    private readonly diagnostics = new RequestDiagnostics();
    setReporter(reporter: (value: ClientDiagnostic) => Promise<void>): void {this.diagnostics.setReporter(reporter);}
    restore(userId: string): void {
        this.diagnostics.restore({read: () => sessionStorage.getItem(`nestos.http-diagnostics.v1:${userId}`),
            write: value => sessionStorage.setItem(`nestos.http-diagnostics.v1:${userId}`,value)});
    }
    readonly browserSessionId = randomUUID();
    private navigation = traceId();
    bootstrap(packet: Promise<unknown>): void {
        const started = Date.now(), operationId = this.browserSessionId;
        void packet.then(() => {
            performance.mark('nestos:bootstrap-received');
            log.info('HTTP bootstrap received', {operation:'http.bootstrap', operationId, stage:'response.decode', result:'success', durationMs:Date.now()-started});
        }, error => {
            const code = (error as {code?:string})?.code;
            log.warn('HTTP bootstrap failed', {operation:'http.bootstrap', operationId, stage:'response.decode', result:'failure',
                code:code && /^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'BOOTSTRAP_FAILED', durationMs:Date.now()-started});
        });
    }
    bindNavigation(signal: AbortSignal): void {
        window.addEventListener(NAVIGATION_EVENTS.START, event => this.beginNavigation((event as CustomEvent<{operationId:string}>).detail?.operationId), {signal});
    }
    beginNavigation(operationId?: string): void {
        this.navigation = operationId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
            && !/^0+$/.test(operationId.replaceAll('-','')) ? operationId.replaceAll('-','') : traceId();
    }
    compatibility(error: unknown): void {
        const value=error as {code?:string;capabilityKind?:string;rpcMethod?:string};
        if(value?.code!=='RPC_METHOD_UNSUPPORTED'||!value.capabilityKind||!value.rpcMethod
            ||![value.capabilityKind,value.rpcMethod].every(name=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)))return;
        const operationId=randomUUID();
        this.diagnostics.add({operation:'http.rpc',operationId,stage:'rpc.decode',code:value.code,result:'failure',durationMs:0,
            http:{browserSessionId:this.browserSessionId,traceId:this.navigation,spanId:randomUUID().replaceAll('-','').slice(0,16),occurredAt:Date.now(),
                method:'POST',route:'/api/application',capabilityKind:value.capabilityKind,rpcMethod:value.rpcMethod}});
    }
    wrap(fetcher: typeof fetch): typeof fetch {
        return async (input, init) => {
            const traceId = this.navigation, spanId = randomUUID().replaceAll('-', '').slice(0,16), started = Date.now(), operationId = randomUUID();
            const headers = new Headers(init?.headers);
            headers.set('traceparent', `00-${traceId}-${spanId}-01`);
            headers.set('X-NestOS-Browser-Session-ID', this.browserSessionId);
            headers.set('X-NestOS-Client-Request-ID',operationId);
            const metadata = requestMetadata(input,init,headers), diagnostic = headers.get('X-NestOS-Diagnostic') === '1' || metadata.rpcMethod === 'reportClientDiagnostic';
            const context = {traceId,spanId,browserSessionId:this.browserSessionId,operation:'http.request',operationId};
            const http = {...metadata,traceId,spanId,browserSessionId:this.browserSessionId,occurredAt:started,
                ...(typeof navigator === 'undefined' ? {} : {online:navigator.onLine})};
            log.debug('HTTP request started',{...context,...metadata,stage:'transport.fetch',result:'started'});
            try {
                const response = await fetcher(input, {...init,headers}), reply = responseMetadata(response), requestId = safeId(response.headers.get('X-Request-ID'));
                const report = response.ok ? log.debug : log.warn;
                report('HTTP response headers', {...context,...metadata,...reply,stage:'response.headers',result:response.ok?'received':'failure',requestId,durationMs:Date.now()-started});
                if (!response.ok && !diagnostic) this.record(operationId,'response.headers',`HTTP_STATUS_${response.status}`,started,{...http,...reply},requestId);
                if (!diagnostic && response.ok) this.diagnostics.flush();
                return this.observeJson(response,operationId,started,{...http,...reply},diagnostic);
            } catch (error) {
                const name = (error as {name?:string})?.name, errorKind = name === 'AbortError' ? 'abort' : name === 'NetworkError' ? 'network' : name === 'TypeError' ? 'type' : 'other';
                const code = errorKind === 'abort' ? 'HTTP_REQUEST_ABORTED' : 'HTTP_CONNECTION_LOST';
                const raw=(error as {code?:unknown;cause?:{code?:unknown}})?.cause?.code??(error as {code?:unknown})?.code;
                const networkCode=typeof raw==='string'&&/^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,63})$/.test(raw)?raw:undefined;
                if (!diagnostic && errorKind !== 'abort') this.record(operationId,'transport.fetch',code,started,{...http,errorKind,...(networkCode?{networkCode}:{})});
                log.warn('HTTP request failed',{...context,...metadata,stage:'transport.fetch',result:'failure',code,errorKind,durationMs:Date.now()-started});
                if (error && typeof error === 'object') {try {Object.assign(error,{clientRequestId:operationId});} catch { /* Keep the original failure. */ }}
                throw error;
            }
        };
    }
    private observeJson(response: Response, operationId: string, started: number, http: NonNullable<ClientDiagnostic['http']>, diagnostic: boolean): Response {
        const json = response.json.bind(response);
        try {response.json = async () => {
            try {return await json();}
            catch (error) {
                const name = (error as {name?:string})?.name, invalid = name === 'SyntaxError', aborted = name === 'AbortError';
                const code = aborted ? 'HTTP_REQUEST_ABORTED' : invalid ? 'HTTP_RESPONSE_INVALID' : 'HTTP_RESPONSE_READ_FAILED', stage = invalid ? 'response.decode' : 'response.body';
                if (!diagnostic && !aborted) this.record(operationId,stage,code,started,http,safeId(response.headers.get('X-Request-ID')));
                throw Object.assign(new Error(`Application response could not be ${invalid?'decoded':'read'} (HTTP ${response.status})`),
                    {code,stage,clientRequestId:operationId,...(aborted?{name:'AbortError'}:{})});
            }
        };} catch { /* A non-extensible response must keep its original behavior. */ }
        return response;
    }
    private record(operationId: string, stage: string, code: string, started: number, http: NonNullable<ClientDiagnostic['http']>, requestId?: string): void {
        this.diagnostics.add({operation:'http.request',operationId,stage,code,result:'failure',durationMs:Math.min(86400000,Math.max(0,Date.now()-started)),http,requestId});
    }
}
function safeId(value: string | null): string | undefined {return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;}

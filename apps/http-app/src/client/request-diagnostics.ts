import type {ClientDiagnostic} from '@nestos/app-contracts/services';
type Http = NonNullable<ClientDiagnostic['http']>;
const routes = new Set(['/api/application','/api/application/events','/api/application/files','/api/health','/api/identity']);
const kinds = new Set(['bootstrap','bootstrap-data','updates-read','queries','bindings','call','callback','reply','close']);
export function requestMetadata(input: RequestInfo | URL, init: RequestInit | undefined, headers: Headers): Pick<Http,'route'|'method'|'rpcKind'|'rpcMethod'|'rpcMethods'|'rpcBatchSize'|'rpcAttempt'|'requestBytes'> {
    let path = ''; try {path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, 'https://localhost').pathname;} catch { /* Never log a caller URL. */ }
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    const kind = headers.get('X-NestOS-RPC-Kind'), rpcMethod = headers.get('X-NestOS-RPC-Method');
    const methods=(headers.get('X-NestOS-RPC-Methods')??'').split(',').filter(name=>/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)).slice(0,32);
    const size=headers.get('X-NestOS-RPC-Batch-Size'),attempt=headers.get('X-NestOS-RPC-Attempt');
    return {route: (routes.has(path) ? path : '/resource') as Http['route'], method: method === 'POST' || method === 'GET' ? method : 'OTHER',
        ...(methods.length?{rpcMethods:methods}:{}),...(size&&/^\d{1,4}$/.test(size)&&Number(size)<=1024?{rpcBatchSize:Number(size)}:{}),
        ...(attempt&&/^[12]$/.test(attempt)?{rpcAttempt:Number(attempt)}:{}),
        ...(kind ? {rpcKind: kinds.has(kind) ? kind : 'other'} : {}),
        ...(rpcMethod && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(rpcMethod) ? {rpcMethod} : {}),
        ...(typeof init?.body === 'string' ? {requestBytes: new TextEncoder().encode(init.body).byteLength} : {})};
}
export function responseMetadata(response: Response): Pick<Http,'status'|'responseType'|'contentLength'> {
    const content = response.headers.get('content-type')?.split(';')[0] ?? '', rawLength = response.headers.get('content-length');
    const size = rawLength && /^\d{1,10}$/.test(rawLength) ? Number(rawLength) : undefined;
    return {...(response.status>=100 && response.status<=599 ? {status:response.status} : {}), responseType: content.includes('json') ? 'json' : content === 'text/html' ? 'html' : content.startsWith('text/') ? 'text' : 'other',
        ...(size !== undefined && size <= 1024**3 ? {contentLength: size} : {})};
}

/** Bounded metadata survives reload; reconnect only reports diagnostics, never replays writes. */
export class RequestDiagnostics {
    private pending: ClientDiagnostic[] = [];
    private reporter?: (value: ClientDiagnostic) => Promise<void>;
    private running?: Promise<void>;
    private persistence?: {read(): string | null; write(value: string): void};
    restore(persistence: NonNullable<RequestDiagnostics['persistence']>): void {
        this.persistence = persistence;
        try {
            const records = JSON.parse(persistence.read() ?? '[]');
            if (Array.isArray(records)) this.pending = [...records.filter(restorable).slice(-16), ...this.pending].slice(-16);
        } catch { /* Storage does not own request execution. */ }
    }
    setReporter(reporter: (value: ClientDiagnostic) => Promise<void>): void {this.reporter = reporter; this.flush();}
    add(value: ClientDiagnostic): void {this.pending.push(value); this.pending = this.pending.slice(-16); this.persist();}
    flush(): void {
        if (!this.reporter || this.running || !this.pending.length) return;
        this.running = this.drain().finally(() => {this.running = undefined;});
    }
    private async drain(): Promise<void> {
        // Drain a bounded snapshot; a failed report remains for the next successful request.
        for (const entry of this.pending.slice(0,2)) {
            try {await this.reporter!(entry);} catch {break;}
            this.pending = this.pending.filter(value => value !== entry); this.persist();
        }
    }
    private persist(): void {try {this.persistence?.write(JSON.stringify(this.pending));} catch { /* Storage may be unavailable. */ }}
}
function restorable(value: unknown): value is ClientDiagnostic {
    if (!value || typeof value !== 'object') return false;
    const v = value as ClientDiagnostic;
    // Only this writer's fixed schema is restored; the host independently validates every field.
    const allowed = ['operation','operationId','stage','code','result','durationMs','requestId','http'];
    return Object.keys(v).every(k => allowed.includes(k)) && v.operation === 'http.request' && typeof v.operationId === 'string'
        && /^[a-f0-9-]{36}$/.test(v.operationId) && v.result === 'failure' && typeof v.durationMs === 'number' && Number.isFinite(v.durationMs)
        && v.durationMs>=0 && v.durationMs<=86400000 && validHttp(v.http) && typeof v.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(v.code)
        && (v.requestId===undefined || typeof v.requestId==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.requestId))
        && typeof v.stage === 'string' && ['transport.fetch','response.headers','response.body','response.decode'].includes(v.stage);
}
function validHttp(value: ClientDiagnostic['http']): boolean {
    if (!value || typeof value !== 'object') return false;
    const patterns: Record<string, RegExp> = {browserSessionId:/^[a-f0-9-]{36}$/,traceId:/^[a-f0-9]{32}$/,spanId:/^[a-f0-9]{16}$/,
        method:/^(GET|POST|OTHER)$/,route:/^\/(api\/(application(?:\/events|\/files)?|health|identity)|resource)$/,
        rpcKind:/^(bootstrap|bootstrap-data|updates-read|queries|bindings|call|callback|reply|close|other)$/,rpcMethod:/^[A-Za-z][A-Za-z0-9_]{0,63}$/,
        networkCode:/^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,63})$/,
        responseType:/^(json|html|text|other)$/,errorKind:/^(abort|network|type|other)$/};
    const limits: Record<string,[number,number]>={occurredAt:[0,8640000000000000],requestBytes:[0,1024**3],contentLength:[0,1024**3],status:[100,599],rpcBatchSize:[0,1024],rpcAttempt:[1,2]};
    if (!['browserSessionId','traceId','spanId','occurredAt','method','route'].every(k => k in value)) return false;
    return Object.entries(value).every(([k,v])=>v===undefined ? Object.hasOwn(patterns,k) || Object.hasOwn(limits,k) || k==='online' || k==='rpcMethods'
        : Object.hasOwn(patterns,k) ? typeof v==='string' && patterns[k].test(v)
        : Object.hasOwn(limits,k) ? typeof v==='number' && Number.isSafeInteger(v) && v>=limits[k][0] && v<=limits[k][1]
        : k==='rpcMethods'?Array.isArray(v)&&v.length<=32&&v.every(name=>typeof name==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name))
        : k==='online' && typeof v==='boolean');
}

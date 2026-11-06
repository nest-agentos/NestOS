import type {AuditEvent} from './audit-log';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomBytes, randomUUID} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {createModuleLogger, diagnosticContext, setDiagnosticContextProvider, type DiagnosticContext} from '@nestos/common';
const storage = new AsyncLocalStorage<DiagnosticContext>();
setDiagnosticContextProvider(() => storage.getStore());
const log = createModuleLogger('cells-transport');
const nonzero = (value: string) => !/^0+$/.test(value);
export function requestTrace(request: IncomingMessage): DiagnosticContext {
    const raw = request.headers.traceparent;
    const match = typeof raw === 'string' ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-(?:00|01)$/.exec(raw) : null;
    const browser = request.headers['x-nestos-browser-session-id'];
    return {traceId: match && nonzero(match[1]) && nonzero(match[2]) ? match[1] : randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'), requestId: randomUUID(),
        ...(match && nonzero(match[1]) && nonzero(match[2]) ? {parentSpanId: match[2]} : {}),
        ...(typeof browser === 'string' && /^[a-f0-9-]{36}$/.test(browser) ? {browserSessionId: browser} : {})};
}
export function traceRequest<T>(request: IncomingMessage, response: ServerResponse, run: () => T): T {
    const context = requestTrace(request);
    response.setHeader('X-Trace-ID', context.traceId);
    response.setHeader('traceparent', `00-${context.traceId}-${context.spanId}-01`);
    return storage.run(context, run);
}
export function traceSpan<T>(run: () => T): T {
    const parent = diagnosticContext();
    return parent ? storage.run({...parent, parentSpanId:parent.spanId, spanId:randomBytes(8).toString('hex')}, run) : run();
}
/** Record only fixed protocol routes; exported paths and URL queries are private. */
export function tracedCellsFetch(fetcher: typeof fetch = globalThis.fetch, report?: (event: AuditEvent) => void): typeof fetch {
    return async (input, init) => {
        const current = diagnosticContext(), spanId = randomBytes(8).toString('hex');
        const context: DiagnosticContext = {...current, traceId: current?.traceId ?? randomBytes(16).toString('hex'), spanId,
            ...(current ? {parentSpanId: current.spanId} : {})};
        const headers = new Headers(init?.headers);
        headers.set('traceparent', `00-${context.traceId}-${spanId}-01`);
        if (context.requestId) headers.set('x-parent-request-id', context.requestId);
        if (context.browserSessionId) headers.set('x-nestos-browser-session-id', context.browserSessionId);
        const pathname = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname;
        const route = /^\/v1\/(?:api\/[a-z_]+\/[a-z_]+|capabilities)$/.test(pathname) ? pathname : '/v1/resource';
        const started = Date.now();
        return storage.run(context, async () => {
            try {const response = await fetcher(input, {...init, headers});
                const event = {operation:'cells.request',stage:'response.headers',result:response.ok?'received':'failure',route,status:response.status,
                    parentRequestId:context.requestId, requestId:safeId(response.headers.get('x-request-id')),durationMs:Date.now()-started};
                log.info('Cells response headers', event);reportSafely(report,{...context,...event,event:'cells.request'});return response;
            } catch (error) {const event = {operation:'cells.request',stage:'transport',result:'failure',route,
                code:safeCode(error),durationMs:Date.now()-started};log.warn('Cells request failed',event);reportSafely(report,{...context,...event,event:'cells.request'});throw error;}
        });
    };
}
function safeId(value: string | null): string | undefined {return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;}
function safeCode(error: unknown): string {const value = (error as {code?: unknown})?.code;return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'CELLS_TRANSPORT_FAILED';}

function reportSafely(report: ((event: AuditEvent) => void) | undefined, event: AuditEvent): void {try {report?.(event);} catch { /* Logging cannot change request outcomes. */ }}

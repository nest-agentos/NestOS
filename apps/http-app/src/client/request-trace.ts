import {createModuleLogger, randomUUID, NAVIGATION_EVENTS} from '@nestos/common';
const log = createModuleLogger('http-client');
const traceId = () => randomUUID().replaceAll('-', '');
/** A navigation owns a trace; each fetch captures its own immutable child span. */
export class BrowserRequestTrace {
    readonly browserSessionId = randomUUID();
    private navigation = traceId();
    bindNavigation(signal: AbortSignal): void {
        window.addEventListener(NAVIGATION_EVENTS.START, event => this.beginNavigation((event as CustomEvent<{operationId:string}>).detail?.operationId), {signal});
    }
    beginNavigation(operationId?: string): void {
        this.navigation = operationId && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(operationId)
            && !/^0+$/.test(operationId.replaceAll('-','')) ? operationId.replaceAll('-','') : traceId();
    }
    wrap(fetcher: typeof fetch): typeof fetch {
        return async (input, init) => {
            const traceId = this.navigation, spanId = randomUUID().replaceAll('-', '').slice(0,16), started = Date.now();
            const headers = new Headers(init?.headers);
            headers.set('traceparent', `00-${traceId}-${spanId}-01`);
            headers.set('X-NestOS-Browser-Session-ID', this.browserSessionId);
            const context = {traceId,spanId,browserSessionId:this.browserSessionId,operation:'http.request'};
            try {const response = await fetcher(input, {...init,headers});
                log.info('HTTP response headers', {...context,stage:'response.headers',result:response.ok?'received':'failure',status:response.status,
                    requestId:safeId(response.headers.get('X-Request-ID')),durationMs:Date.now()-started});return response;
            } catch (error) {log.warn('HTTP request failed', {...context,stage:'transport',result:'failure',durationMs:Date.now()-started});throw error;}
        };
    }
}
function safeId(value: string | null): string | undefined {return value && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined;}

/** Hosts inject async-local correlation without introducing platform dependencies. */
export interface DiagnosticContext {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    requestId?: string;
    browserSessionId?: string;
}
let provider: (() => DiagnosticContext | undefined) | undefined;
export function setDiagnosticContextProvider(value: () => DiagnosticContext | undefined): void {provider = value;}
export function diagnosticContext(): DiagnosticContext | undefined {return provider?.();}

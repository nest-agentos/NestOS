import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
export type Cleanup = (() => void | Promise<void>) & {cleanupStage?: string};
interface Context {operationId: string; path: string}
const context = new AsyncLocalStorage<Context>();
export function namedCleanup(stage: string, close: () => void | Promise<void>): Cleanup {return Object.assign(close, {cleanupStage: stage});}
function diagnostic(fields: Record<string, unknown>): void {
    console.info('[HTTPShutdown]', JSON.stringify({operation: 'http.shutdown', pid: process.pid, ...fields}));
}
function errorCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'HOST_CLEANUP_FAILED';
}
/** Observe a stage without skipping cleanup or releasing storage beneath active work. */
export async function traceHostCleanup<T>(stage: string, run: () => T | Promise<T>, rootOperationId?:string): Promise<T> {
    const parent = context.getStore(), operationId = parent?.operationId ?? rootOperationId ?? randomUUID();
    const path = parent ? `${parent.path}/${stage}` : stage, started = Date.now(), cpu = process.cpuUsage();
    const fields = {operationId, stage: path};
    diagnostic({...fields, result: 'started'});
    const pending = setInterval(() => diagnostic({...fields, result: 'waiting', durationMs: Date.now() - started,
        cpuMs: Math.round((process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) / 1000)}), 5000); pending.unref();
    try {
        const result = await context.run({operationId, path}, run);
        diagnostic({...fields, result: 'success', durationMs: Date.now() - started}); return result;
    } catch (error) {
        diagnostic({...fields, result: 'failure', code: errorCode(error), durationMs: Date.now() - started}); throw error;
    } finally {clearInterval(pending);}
}
export function shutdownSignal(signal: string): string {const operationId=randomUUID();diagnostic({operationId,stage:'signal',signal,result:'received'});return operationId;}
/** Bound direct launches too, without retaining an otherwise idle event loop. */
export function shutdownDeadline(operationId:string,timeoutMs=15000,exit:(code:number)=>void=code=>process.exit(code)):()=>void {
    const started=Date.now();
    const timer=setTimeout(()=>{diagnostic({operationId,stage:'deadline',result:'failure',code:'HTTPD_SHUTDOWN_DEADLINE',forced:true,durationMs:Date.now()-started});exit(1);},timeoutMs);
    timer.unref();return ()=>clearTimeout(timer);
}

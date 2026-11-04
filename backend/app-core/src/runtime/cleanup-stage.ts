function emit(fields: Record<string, unknown>): void {console.info('[RuntimeCleanup]', JSON.stringify(fields));}
export type CleanupStep = (() => void | Promise<void>) & {cleanupStage?: string};
export function cleanupStep(stage: string, close: () => void | Promise<void>): CleanupStep {return Object.assign(close, {cleanupStage: stage});}
export async function cleanupStage<T>(operationId: string, stage: string, run: () => T | Promise<T>): Promise<T> {
    const started = Date.now(), fields = {operation: 'application.dispose', operationId, stage};
    emit({...fields, result: 'started'});
    const timer = setInterval(() => emit({...fields, result: 'waiting', durationMs: Date.now() - started}), 5000);
    try {
        const result = await run(); emit({...fields, result: 'success', durationMs: Date.now() - started}); return result;
    } catch (error) {
        const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'RUNTIME_CLEANUP_FAILED';
        emit({...fields, result: 'failure', code, durationMs: Date.now() - started}); throw error;
    } finally {clearInterval(timer);}
}

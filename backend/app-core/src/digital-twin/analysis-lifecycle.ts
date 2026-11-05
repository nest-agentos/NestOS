import type {TwinAnalysisJob} from './domain';
import {traceAnalysis} from './diagnostics';

export type TwinExecutionPhase = NonNullable<TwinAnalysisJob['executionPhase']>;
export interface TwinExtractionLifecycle {
    active(): boolean;
    checkpoint(phase: TwinExecutionPhase): Promise<void>;
}
/** A host checkpoint is control flow, never business failure or user cancellation. */
export class TwinSafePoint extends Error {
    constructor() {super('TWIN_SAFE_POINT');}
}
export class TwinResultPending extends Error {
    constructor(cause: unknown) {super('TWIN_RESULT_COMMIT_PENDING', {cause});}
}
export function requireActive(active: () => boolean): void {if (!active()) throw new TwinSafePoint();}
export async function extractionStep<T>(job: TwinAnalysisJob, stage: string, work: () => Promise<T>): Promise<T> {
    const started = Date.now(); traceAnalysis(job, stage, {operation: 'twin.analysis', operationId: job.sessionId, result: 'started'});
    try {
        const value = await work();
        traceAnalysis(job, stage, {operation: 'twin.analysis', operationId: job.sessionId, result: 'success', durationMs: Date.now() - started});
        return value;
    } catch (error) {
        const failure = error as {code?: unknown; message?: unknown};
        const code = error instanceof TwinSafePoint ? 'TWIN_SAFE_POINT' : failure?.code ?? failure?.message;
        traceAnalysis(job, stage, {operation: 'twin.analysis', operationId: job.sessionId, result: error instanceof TwinSafePoint ? 'checkpoint' : 'failure',
            code: typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : 'TWIN_ANALYSIS_STEP_FAILED', durationMs: Date.now() - started});
        throw error;
    }
}

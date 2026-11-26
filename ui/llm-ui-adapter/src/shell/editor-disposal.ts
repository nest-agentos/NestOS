import {createModuleLogger, randomUUID} from '@nestos/common';

const log = createModuleLogger('editor-disposal');
type Release = () => void | Promise<void>;
type DisposalStep = Release | {stage: string; release: Release};

/** Release every resource in order, even when a preceding save or disposal fails. */
export async function disposeEditorResources(steps: readonly DisposalStep[]): Promise<void> {
    const failures: unknown[] = [];
    let operationId: string | undefined;
    for (const [index, step] of steps.entries()) {
        const release = typeof step === 'function' ? step : step.release;
        const started = performance.now();
        try {await release();}
        catch (error) {
            failures.push(error);
            operationId ??= randomUUID();
            const detail = error as {code?: unknown; requestId?: unknown; viewReason?: unknown} | undefined;
            log.warn('editor.dispose', {operationId, stage: typeof step === 'function' ? 'release' : step.stage, step: index + 1,
                result: 'failure', durationMs: Math.round(performance.now() - started),
                code: safeField(detail?.viewReason ?? detail?.code, /^[A-Z][A-Z0-9_]{0,79}$/) ?? 'EDITOR_DISPOSAL_STEP_FAILED',
                requestId: safeField(detail?.requestId, /^[a-zA-Z0-9_-]{1,128}$/)});
        }
    }
    if (failures.length) throw new AggregateError(failures, 'Editor disposal failed', {cause: failures[0]});
}

function safeField(value: unknown, pattern: RegExp): string | undefined {
    return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

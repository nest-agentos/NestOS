import {randomUUID} from '@nestos/common';

export type Cleanup = () => void | Promise<void>;
function failureDetail(error: unknown) {
    const detail = error as {code?: unknown; requestId?: unknown};
    return {
        code: typeof detail?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(detail.code) ? detail.code : 'WORKSPACE_CLEANUP_FAILED',
        requestId: typeof detail?.requestId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(detail.requestId) ? detail.requestId : undefined,
    };
}

/** A partially constructed workspace owns its cleanup even when another one loads concurrently. */
export function cleanupGroup(recovering: () => boolean = () => false) {
    const callbacks: Cleanup[] = [];
    return {
        own(cleanup: Cleanup): void { callbacks.push(cleanup); },
        async close(): Promise<void> {
            const operationId = randomUUID(), started = performance.now();
            let unavailable = 0, firstUnavailable: ReturnType<typeof failureDetail> | undefined;
            for (const cleanup of callbacks.splice(0).reverse()) {
                try { await cleanup(); } catch (error) {
                    const detail = failureDetail(error);
                    if (recovering() && detail.code === 'ECAPABILITY') {unavailable++;firstUnavailable ??= detail;continue;}
                    console.error('[Shell] Workspace cleanup failed', {
                        operation: 'workspace.cleanup', operationId, stage: 'release', result: 'failure', ...detail,
                        durationMs: Math.round(performance.now() - started),
                    });
                }
            }
            if (unavailable) console.warn('[Shell] Workspace cleanup unavailable during recovery', {
                operation: 'workspace.cleanup', operationId, stage: 'release', result: 'unavailable', ...firstUnavailable,
                count: unavailable, durationMs: Math.round(performance.now() - started),
            });
        },
    };
}

import {randomUUID} from 'node:crypto';
import {safeStartupCode, type StorageStartupDiagnostic} from '../storage/startup-error';

/** Startup diagnostics stay local and never include configuration values, SQL or raw exception bodies. */
export function reportHttpStartupFailure(error: unknown): void {
    const value = error as {startupDiagnostic?: StorageStartupDiagnostic; code?: unknown; stack?: string};
    const detail = value?.startupDiagnostic;
    const frames = typeof value?.stack === 'string' ? value.stack.split('\n').slice(1).filter(line => /^\s+at /.test(line)).slice(0, 6) : [];
    console.error('[HTTPStartup]', JSON.stringify({operation: 'http.start', result: 'failure', ...detail,
        operationId: detail?.operationId ?? randomUUID(), stage: detail?.stage ?? 'startup', code: detail?.code ?? safeStartupCode(value?.code) ?? 'HTTP_STARTUP_FAILED',
        errorType: error instanceof Error ? error.name : 'unknown', frames}));
    if (detail) console.error(`${detail.code}: ${detail.hint}\nDatabase: ${detail.database}\nOpen by PIDs: ${detail.openByPids.join(', ') || 'not identified'} (${detail.processLookup})`);
    else console.error('HTTP startup failed; inspect the operation ID, stage, error code and stack locations above.');
}

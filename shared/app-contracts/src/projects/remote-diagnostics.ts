import { createModuleLogger, getLogger, LogLevel } from '@nestos/common';
import { FSError } from '@nestos/vfs-core';

export type CellsConnectionReason = 'ready' | 'cells-not-found';
export interface CellsConnectionDiagnostic {
    connectionId: string; connectionName?: string; reason: CellsConnectionReason; revision: number;
    configured: {id: string; name: string; reason: CellsConnectionReason}[];
}
interface RemoteFailureContext {
    stage: string; projectId?: string; profileId?: string; sessionId?: string; connectionId?: string;
    operationId?: string; durationMs?: number;
}
export const remoteLog = createModuleLogger('cells');
const reported = new WeakSet<object>();

/** Only catalog identities and fixed reason codes cross the diagnostic boundary. */
export class RemoteConnectionUnavailableError extends FSError {
    constructor(readonly diagnostic: CellsConnectionDiagnostic, readonly projectIds: string[]) {
        super('ENOENT', 'Project Cells connection unavailable', 'remote-connection');
        this.name = 'RemoteConnectionUnavailableError';
    }
}

export function reportRemoteFailure(error: unknown, context: RemoteFailureContext): void {
    if (error instanceof FSError && error.code === 'ECANCELLED') return;
    const [code, ...causeCodes] = failureCodes(error);
    const requestId = failureRequestId(error);
    const data = {source: 'itookit', ...context, code: code ?? 'REMOTE_ERROR_WITHOUT_CODE',
        errorType: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : 'unknown',
        ...(causeCodes.length ? {causeCodes} : {}), ...(requestId ? {requestId} : {}),
        ...(error instanceof RemoteConnectionUnavailableError
            ? {...error.diagnostic, projectIds: error.projectIds, stack: error.stack} : {})};
    if (error instanceof Error && reported.has(error)) { remoteLog.debug('remote.operation.failed', data); return; }
    if (error instanceof Error) reported.add(error);
    remoteLog.error('remote.operation.failed', data);
    if (getLogger().getLevel('cells') <= LogLevel.ERROR)
        console.error(`${new Date().toISOString()} [itookit/cells] remote.operation.failed`, data);
}

function failureRequestId(error: unknown): string | undefined {
    if (!(error instanceof Error)) return;
    const details = error as Error & {requestId?: unknown; clientRequestId?: unknown};
    const id = details.requestId ?? details.clientRequestId;
    return typeof id === 'string' && /^[a-f\d-]{36}$/i.test(id) ? id : undefined;
}

function failureCodes(error: unknown): string[] {
    const codes: string[] = [], seen = new Set<Error>();
    for (let depth = 0; depth < 8 && error instanceof Error && !seen.has(error); depth++) {
        seen.add(error);
        const code = (error as Error & {code?: unknown}).code;
        if (typeof code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(code)) codes.push(code);
        error = error.cause;
    }
    return codes;
}

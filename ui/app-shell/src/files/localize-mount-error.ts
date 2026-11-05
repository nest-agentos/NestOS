import { t, type LocaleKey } from '@nestos/common';
import { DirectorySourceUnavailableError, SessionUnfinishedTasksError, RemoteConnectionUnavailableError, type CellsConnectionReason, type CellsConnectionDiagnostic } from '@nestos/app-contracts';

const connectionReasons: Record<CellsConnectionReason, LocaleKey> = {
    'ready': 'remote.connectionReason.ready', 'cells-not-found': 'remote.connectionReason.missing',
};
export function localizeConnectionReason(diagnostic: Pick<CellsConnectionDiagnostic, 'reason' | 'connectionName'>): string {
    return t(connectionReasons[diagnostic.reason], {name: diagnostic.connectionName ?? ''});
}

/**
 * Map platform-agnostic mount errors to localized copy.
 *
 * `@nestos/app-core` raises structured errors and owns no user-facing text (see its
 * AGENTS.md); the host decides how to phrase them. Unknown errors pass through unchanged
 * so their message is not swallowed.
 */
export function localizeMountError(error: unknown): unknown {
    let cause = error;
    for (let depth = 0; depth < 16 && cause instanceof Error; depth++, cause = cause.cause) {
        if (cause instanceof RemoteConnectionUnavailableError) {
            return new Error(t('remote.connectionUnavailable', {reason: localizeConnectionReason(cause.diagnostic)}));
        }
    }
    if (error instanceof SessionUnfinishedTasksError) return new Error(t('error.sessionUnfinishedTasks'));
    if (error instanceof DirectorySourceUnavailableError) return new Error(t('error.directorySourceUnavailable'));
    return error;
}

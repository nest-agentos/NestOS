import {createModuleLogger, randomUUID, t} from '@nestos/common';

const log = createModuleLogger('draft-loading');
type Stage = 'attachments' | 'configuration' | 'targets';

/** Keep asynchronous restoration visible without logging draft contents. */
export function draftLoading(container: HTMLElement, signal?: AbortSignal) {
    const notice = document.createElement('p'), operationId = randomUUID();
    notice.className = 'llm-draft-loading'; notice.setAttribute('role', 'status'); container.append(notice);
    return {
        async read<T>(stage: Stage, read: () => Promise<T>): Promise<T> {
            const started = performance.now(); notice.textContent = t(`project.draftLoading.${stage}`);
            try {
                signal?.throwIfAborted(); const result = await read(); signal?.throwIfAborted();
                log.debug('draft.open', {operationId, stage, result: 'success', durationMs: Math.round(performance.now() - started)});
                return result;
            } catch (error) {
                const raw = (error as {code?: unknown})?.code;
                const network = raw === 'HTTP_CONNECTION_LOST' || error instanceof Error && /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(error.message);
                const code = signal?.aborted ? 'ABORTED' : network ? 'HTTP_CONNECTION_LOST' : typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'DRAFT_OPEN_FAILED';
                log.warn('draft.open', {operationId, stage, result: 'failure', code, durationMs: Math.round(performance.now() - started)});
                if (signal?.aborted) notice.remove();
                else {notice.setAttribute('role', 'alert'); notice.textContent = `${t('project.draftLoading.failed')} ${error instanceof Error ? error.message : code}`;}
                if (network && !signal?.aborted) notice.textContent = t('project.draftLoading.connection');
                throw error;
            }
        },
        retry: (action: () => void) => {
            const button = document.createElement('button');
            button.type = 'button'; button.textContent = t('project.draftLoading.retry');
            button.addEventListener('click', action, {once: true}); notice.append(' ', button);
        },
        finish: () => notice.remove(),
    };
}

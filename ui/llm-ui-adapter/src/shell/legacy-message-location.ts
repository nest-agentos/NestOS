import {createModuleLogger, randomUUID, t} from '@nestos/common';
import {Toast} from '@nestos/ui-common-adapter';

const log = createModuleLogger('legacy-history-location');

/** Show the selected source message inside its owning legacy transcript window. */
export function revealLegacyMessage(window: HTMLElement | null, id: string, text: string): HTMLElement | null {
    const operationId = randomUUID(), started = Date.now();
    if (!window) {
        log.warn('history.locate', {operationId, operation: 'history.locate', stage: 'resolve', result: 'failure', code: 'MESSAGE_UNAVAILABLE', durationMs: Date.now() - started});
        Toast.error(t('chat.historyLocationUnavailable')); return null;
    }
    let target = window.querySelector<HTMLElement>(':scope > [data-legacy-message-location]');
    if (!target) {
        target = document.createElement('section'); target.dataset.legacyMessageLocation = '';
        target.className = 'llm-ui-session__message-location'; target.tabIndex = -1;
        const label = document.createElement('strong'); label.textContent = t('chat.historyLocatedInput');
        target.append(label, document.createElement('pre')); window.append(target);
    }
    window.dataset.legacyMessageLocated = 'true';
    target.dataset.messageId = id; target.querySelector('pre')!.textContent = text;
    target.scrollIntoView?.({block: 'center'}); target.focus({preventScroll: true});
    log.info('history.locate', {operationId, operation: 'history.locate', stage: 'reveal', result: 'success', durationMs: Date.now() - started}); return target;
}

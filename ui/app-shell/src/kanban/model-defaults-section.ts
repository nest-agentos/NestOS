import {createModuleLogger, randomUUID, t} from '@nestos/common';
import type {KanbanClient} from '@nestos/kanban/contracts';
import {KanbanBoardSettings} from './board-settings';

const log = createModuleLogger('kanban-model-defaults');

export function mountDecisionHarnessSettings(host: HTMLElement, service: KanbanClient): {destroy(): void} {
    const title = document.createElement('h2'), boardLabel = document.createElement('label'), row = document.createElement('div');
    const boards = document.createElement('select'), status = document.createElement('p');
    const retry = document.createElement('button'), lifetime = new AbortController();
    const settings = new KanbanBoardSettings(service, async () => {}, () => {}, busy => { boards.disabled = busy; }, 'harness-decision');
    title.textContent = t('modelDefaults.decisionHarness');
    boardLabel.textContent = t('modelDefaults.decisionBoard');
    boardLabel.htmlFor = boards.id = 'model-defaults-decision-board-' + randomUUID();
    row.className = 'model-defaults__row';
    boards.className = 'settings-form__select';
    status.setAttribute('role', 'status');
    retry.type = 'button'; retry.textContent = t('kanban.refresh');
    const load = () => { void readBoards(service, boards, status, retry, lifetime.signal); };
    retry.addEventListener('click', load, {signal: lifetime.signal});
    boards.addEventListener('change', () => { void settings.select(boards.value || undefined); }, {signal: lifetime.signal});
    host.classList.add('model-defaults');
    row.append(boardLabel, boards, status, retry);
    host.append(title, row, settings.element);
    load();
    return {destroy: () => { lifetime.abort(); settings.destroy(); host.replaceChildren(); }};
}

async function readBoards(service: KanbanClient, select: HTMLSelectElement, status: HTMLElement, retry: HTMLButtonElement, signal: AbortSignal): Promise<void> {
    const operationId = randomUUID(), started = performance.now(), stage = 'board-list';
    retry.hidden = true; select.disabled = true; status.textContent = t('kanban.boardControl.loading');
    try {
        const boards = (await service.catalog()).filter(board => !board.lifecycle);
        if (signal.aborted) return;
        select.replaceChildren(new Option(t('kanban.boardControl.selectBoard'), ''), ...boards.map(board => new Option(board.title, board.id)));
        status.textContent = boards.length ? '' : t('modelDefaults.noDecisionBoards');
        select.disabled = !boards.length;
        if (boards.length === 1) {
            select.value = boards[0].id;
            select.dispatchEvent(new Event('change'));
        }
        log.debug('settings.read', {operationId, stage, result: 'success', count: boards.length, durationMs: Math.round(performance.now()-started)});
    } catch (error) {
        if (signal.aborted) return;
        const value = (error as {code?: unknown})?.code;
        const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'KANBAN_OPERATION_FAILED';
        status.textContent = t('modelDefaults.decisionBoardsFailed', {code});
        retry.hidden = false;
        log.warn('settings.read', {operationId, stage, result: 'failure', code, durationMs: Math.round(performance.now()-started)});
    }
}

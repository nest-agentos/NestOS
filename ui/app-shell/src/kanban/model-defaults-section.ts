import {createModuleLogger, randomUUID, t} from '@nestos/common';
import type {KanbanClient} from '@nestos/kanban/contracts';
import {allBoards, KanbanBoardSettings, type GlobalHarnessDefaults} from './board-settings';

const log = createModuleLogger('kanban-model-defaults');

export function mountKanbanHarnessSettings(host: HTMLElement, service: KanbanClient, global: GlobalHarnessDefaults): {destroy(): void} {
    const boardLabel = document.createElement('label'), row = document.createElement('div');
    const boards = document.createElement('select'), status = document.createElement('p');
    const retry = document.createElement('button'), lifetime = new AbortController();
    const settings = new KanbanBoardSettings(service, async () => {}, () => {}, busy => { boards.disabled = busy; }, global);
    boardLabel.textContent = t('modelDefaults.harnessScope');
    boardLabel.htmlFor = boards.id = 'model-defaults-harness-scope-' + randomUUID();
    row.className = 'model-defaults__row';
    boards.className = 'settings-form__select';
    status.setAttribute('role', 'status');
    retry.type = 'button'; retry.textContent = t('kanban.refresh');
    boards.add(new Option(t('modelDefaults.allBoards'), allBoards));
    const load = () => { void readBoards(service, boards, status, retry, lifetime.signal); };
    retry.addEventListener('click', load, {signal: lifetime.signal});
    boards.addEventListener('change', () => { void settings.select(boards.value || undefined); }, {signal: lifetime.signal});
    host.classList.add('model-defaults');
    row.append(boardLabel, boards, status, retry);
    host.append(row, settings.element);
    load(); void settings.select(allBoards);
    return {destroy: () => { lifetime.abort(); settings.destroy(); host.replaceChildren(); }};
}

async function readBoards(service: KanbanClient, select: HTMLSelectElement, status: HTMLElement, retry: HTMLButtonElement, signal: AbortSignal): Promise<void> {
    const operationId = randomUUID(), started = performance.now(), stage = 'board-list';
    retry.hidden = true; status.textContent = t('kanban.boardControl.loading');
    try {
        const boards = (await service.catalog()).filter(board => !board.lifecycle);
        if (signal.aborted) return;
        const selected=select.value;
        select.replaceChildren(new Option(t('modelDefaults.allBoards'), allBoards), ...boards.map(board => new Option(board.title, board.id)));
        select.value=boards.some(board=>board.id===selected)?selected:allBoards;
        if(selected!==select.value)select.dispatchEvent(new Event('change'));
        status.textContent = '';
        log.debug('settings.read', {operationId, stage, result: 'success', count: boards.length, durationMs: Math.round(performance.now()-started)});
    } catch (error) {
        if (signal.aborted) return;
        const value = (error as {code?: unknown})?.code;
        const code = typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : 'KANBAN_OPERATION_FAILED';
        status.textContent = t('modelDefaults.harnessBoardsFailed', {code});
        retry.hidden = false;
        log.warn('settings.read', {operationId, stage, result: 'failure', code, durationMs: Math.round(performance.now()-started)});
    }
}

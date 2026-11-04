import {ACTION_ICONS, CHAT_ICONS, createModuleLogger, randomUUID, t} from '@itookit/common';
import type {KanbanBoardSummary, KanbanClient, KanbanCommand} from '@itookit/kanban/contracts';

const log = createModuleLogger('kanban-sidebar-controls');
export const controlLabel = (key: string) => t(`kanban.boardControl.${key}` as Parameters<typeof t>[0]);
type Command = Extract<KanbanCommand, {type: 'set-board-control'}>;
export const controlIcon = (phase: string) => ['paused', 'pausing'].includes(phase) ? ACTION_ICONS.pause : phase === 'manual' ? CHAT_ICONS.edit : phase === 'error' ? ACTION_ICONS.info : ACTION_ICONS.run;

/** Scope is explicit; each board is revision checked and partial failures are retained. */
export class KanbanSidebarControls {
    private dialog?: HTMLDialogElement;
    private render?: (boards: KanbanBoardSummary[]) => void;
    private busy = false;
    private closed = false;
    constructor(private readonly service: KanbanClient, private readonly changed: () => Promise<void>, private readonly report: (error: unknown) => void) {}
    open(boards: KanbanBoardSummary[], selected?: string): void {
        if (this.dialog) {this.dialog.focus(); return;}
        const dialog = document.createElement('dialog'), title = document.createElement('h2');
        dialog.className = 'kanban-sidebar-controls'; dialog.setAttribute('aria-label', controlLabel('settings')); title.textContent = controlLabel('settings');
        const close = document.createElement('button'); close.type = 'button'; close.textContent = t('action.close'); close.onclick = () => dialog.close();
        const header = document.createElement('header'); header.append(title, close);
        const scope = document.createElement('select'); scope.setAttribute('aria-label', controlLabel('scope'));
        scope.append(new Option(controlLabel('all'), '*'));
        boards.forEach(board => scope.append(new Option(board.title, board.id))); scope.value = selected ?? '*';
        const help = document.createElement('p'); help.textContent = controlLabel('help');
        const state = document.createElement('p'); state.setAttribute('role', 'status');
        const buttons = this.actions(boards, scope, state);
        this.bindState(boards, scope, state, buttons);
        dialog.append(header, scope, help, state, buttons); document.body.append(dialog); this.dialog = dialog;
        const origin = document.activeElement;
        dialog.addEventListener('cancel', event => {if (this.busy) event.preventDefault();});
        dialog.addEventListener('close', () => {dialog.remove(); this.dialog = undefined; this.render = undefined; if (origin instanceof HTMLElement && origin.isConnected) origin.focus();}, {once: true});
        dialog.showModal();
    }
    private actions(boards: KanbanBoardSummary[], scope: HTMLSelectElement, state: HTMLElement): HTMLElement {
        const buttons = document.createElement('div'); buttons.className = 'kanban-sidebar-controls__actions';
        const commands: Array<[string, string, Command]> = [
            ['automatic', ACTION_ICONS.run, {type: 'set-board-control', mode: 'automatic'}],
            ['manual', CHAT_ICONS.edit, {type: 'set-board-control', mode: 'manual'}],
            ['pause', ACTION_ICONS.pause, {type: 'set-board-control', paused: true}],
            ['resume', ACTION_ICONS.run, {type: 'set-board-control', paused: false}],
        ];
        for (const [key, icon, command] of commands) {
            const button = document.createElement('button'); button.type = 'button'; button.innerHTML = icon;
            button.dataset.boardControl = key; button.append(document.createTextNode(controlLabel(key))); button.onclick = () => {void this.apply(scope.value === '*' ? boards : boards.filter(board => board.id === scope.value), command, state, buttons);}; buttons.append(button);
        }
        return buttons;
    }
    private bindState(boards: KanbanBoardSummary[], scope: HTMLSelectElement, state: HTMLElement, buttons: HTMLElement): void {
        this.render = fresh => {
            boards.forEach(board => {const next = fresh.find(entry => entry.id === board.id); if (next) Object.assign(board, next);});
            const targets = scope.value === '*' ? boards : boards.filter(board => board.id === scope.value);
            if (!this.busy) state.textContent = targets.map(board => board.title + ': ' + controlLabel(board.executionPhase ?? 'automatic')).join('\n');
            const paused = targets.length > 0 && targets.every(board => board.executionControl?.paused);
            buttons.querySelectorAll<HTMLButtonElement>('[data-board-control]').forEach(button => {
                const key = button.dataset.boardControl;
                button.hidden = key === 'pause' ? paused : key === 'resume' ? !targets.some(board => board.executionControl?.paused) : false;
                button.disabled = this.busy || !targets.length || targets.some(board => ['pausing', 'resuming'].includes(board.executionPhase ?? '')) && (key === 'pause' || key === 'resume');
            });
        };
        scope.onchange = () => this.render?.(boards); this.render(boards);
    }
    update(boards: KanbanBoardSummary[]): void {this.render?.(boards);}
    async toggle(board: KanbanBoardSummary): Promise<void> {await this.apply([board], {type: 'set-board-control', paused: !board.executionControl?.paused});}
    destroy(): void {this.closed = true; this.dialog?.close();}
    private async apply(boards: KanbanBoardSummary[], command: Command, state?: HTMLElement, buttons?: HTMLElement): Promise<void> {
        if (this.busy || this.closed) return; this.busy = true;
        this.dialog?.setAttribute('aria-busy', 'true');
        buttons?.querySelectorAll('button').forEach(button => {button.disabled = true;});
        if (state) state.textContent = controlLabel('processing');
        const failures: string[] = [];
        try {
            for (const board of boards) {
                const operationId = randomUUID(), started = performance.now();
                try {
                    await this.service.execute(board.id, {operationId, expectedRevision: board.revision, command});
                    log.debug('board.control', {operationId, boardId: board.id, stage: 'commit', result: 'success', durationMs: Math.round(performance.now() - started)});
                } catch (error) {
                    const raw = (error as {code?: unknown})?.code, code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'KANBAN_OPERATION_FAILED';
                    failures.push(board.title + ': ' + code);
                    log.warn('board.control', {operationId, boardId: board.id, stage: 'commit', result: 'failure', code, durationMs: Math.round(performance.now() - started)});
                }
            }
            await this.changed();
            if (!this.closed && state) state.textContent = failures.length ? failures.join('\n') : boards.map(board => board.title + ': ' + controlLabel(board.executionPhase ?? 'automatic')).join('\n');
            if (failures.length) this.report(Object.assign(new Error(failures.join('\n')), {code: 'BOARD_CONTROL_PARTIAL_FAILURE'}));
        } catch (error) {this.report(error); if (!this.closed && state) state.textContent = controlLabel('refreshFailed');}
        finally {this.busy = false; this.dialog?.removeAttribute('aria-busy'); this.render?.(boards); if (failures.length && state) state.textContent = failures.join('\n');}
    }
}

import {createModuleLogger, escapeHTML, getLocale, randomUUID, t} from '@nestos/common';
import type {ICommandBus} from '@nestos/llm-session/contracts';
import {FlowCommand, type FlowRunPreview, type FlowRunSummary} from '@nestos/llm-flow/contracts';
import {runStatus, runTitle} from '../../flows/run-presentation';

const log = createModuleLogger('flow-run-picker');

export function openRunPicker(commands: ICommandBus, select: (run: FlowRunSummary) => Promise<void>): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'dag-dialog dag-run-picker';
    dialog.innerHTML = `<form method="dialog"><h2>${escapeHTML(t('flow.runs.title'))}</h2>
        <div class="dag-run-list" data-runs aria-live="polite">${escapeHTML(t('status.loading'))}</div>
        <menu><button>${escapeHTML(t('flow.transcript.close'))}</button></menu></form>`;
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    dialog.addEventListener('click', event => {
        if ((event.target as Element).closest('[data-run-session]') && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) dialog.close();
    });
    document.body.append(dialog); dialog.showModal();
    void loadRuns(dialog, commands, select);
}

async function loadRuns(dialog: HTMLDialogElement, commands: ICommandBus, select: (run: FlowRunSummary) => Promise<void>): Promise<void> {
    const list = dialog.querySelector<HTMLElement>('[data-runs]')!, operationId = randomUUID(), started = Date.now();
    try {
        const runs = await commands.execute<FlowRunSummary[]>(FlowCommand.RunList, {});
        if (!dialog.isConnected) return;
        list.innerHTML = runs.length ? runs.map(runCard).join('') : escapeHTML(t('flow.runs.empty'));
        list.addEventListener('click', event => {
            const button = (event.target as Element).closest<HTMLButtonElement>('[data-run-index]');
            if (!button || button.disabled) return;
            const message = button.closest('article')!.querySelector<HTMLElement>('[data-run-error]')!;
            button.disabled = true; message.textContent = '';
            void select(runs[Number(button.dataset.runIndex)]).then(() => dialog.close(), error => {
                if (dialog.isConnected) {button.disabled = false; message.textContent = error instanceof Error ? error.message : String(error);}
                log.warn('run.open', {operationId, stage: 'details', result: 'failure', code: 'FLOW_RUN_OPEN_FAILED', durationMs: Date.now() - started});
            });
        });
        log.info('runs.list', {operationId, stage: 'list', result: 'success', count: runs.length, durationMs: Date.now() - started});
    } catch (error) {
        if (dialog.isConnected) list.textContent = error instanceof Error ? error.message : String(error);
        log.warn('runs.list', {operationId, stage: 'list', result: 'failure', code: 'FLOW_RUN_LIST_FAILED', durationMs: Date.now() - started});
    }
}

function runCard(run: FlowRunSummary, index: number): string {
    const date = new Date(run.createdAt), valid = Number.isFinite(date.getTime());
    const time = valid ? date.toLocaleString(getLocale(), {hour12: false}) : t('flow.runs.unknownTime');
    return `<article class="dag-run-list__item">
        <header class="dag-run-list__header"><h3><button type="button" class="dag-run-list__title" data-run-index="${index}" title="${escapeHTML(t('flow.runs.viewDetails'))}">${escapeHTML(runTitle(run))}</button></h3>
            <span class="dag-run-list__status" data-status="${escapeHTML(run.status)}">${escapeHTML(runStatus(run.status))}</span></header>
        <div class="dag-run-list__meta"><span>${escapeHTML(t('flow.runs.createdAt'))} <time${valid ? ` datetime="${date.toISOString()}"` : ''}>${escapeHTML(time)}</time></span>
            <a data-run-session href="#/chat/${encodeURIComponent(run.sessionId)}">${escapeHTML(t('flow.runs.openSession'))} · #${escapeHTML(run.sessionId.slice(-8))}</a></div>
        <dl class="dag-run-list__previews">${preview(t('flow.runs.input'), run.inputPreview, t('flow.runs.noInput'))}${preview(t('flow.runs.output'), run.outputPreview, t('flow.runs.noOutput'))}</dl>
        <p class="dag-run-list__error" data-run-error role="alert"></p></article>`;
}

function preview(label: string, value: FlowRunPreview | undefined, empty: string): string {
    return `<div><dt>${escapeHTML(label)}${value?.truncated ? ` <small>${escapeHTML(t('flow.runs.truncated'))}</small>` : ''}</dt>
        <dd><pre>${escapeHTML(value ? value.text + (value.truncated ? '\n…' : '') : empty)}</pre></dd></div>`;
}

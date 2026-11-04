import type {MailPage, MailQuery} from '../contracts';
import {ThreadReader} from './reader';
import {button, element, type MailUIOptions} from './ports';
export type {MailUIOptions, MailPresentation, MailReader} from './ports';
export class MailWorkbench {
    private readonly abort = new AbortController();
    private readonly reader: ThreadReader;
    private query: MailQuery = {page: 1};
    private revision = 0;
    private active = '';
    private visible = true;
    private dirty = false;
    private loading?: Promise<void>;
    private timer?: ReturnType<typeof setTimeout>;
    private source!: HTMLSelectElement;
    private search!: HTMLInputElement;
    private mode!: HTMLSelectElement;
    private list!: HTMLElement;
    private alert!: HTMLElement;
    private pageLabel!: HTMLElement;
    private previous!: HTMLButtonElement;
    private next!: HTMLButtonElement;
    constructor(private readonly options: MailUIOptions) {this.reader = new ThreadReader(options, (error, stage) => this.failure(error, stage));}
    async start(): Promise<void> {this.mount(); await this.refresh();}
    private mount(): void {
        const {sidebar, editor, presentation: p} = this.options, signal = this.abort.signal, t = p.text;
        sidebar.classList.add('mail__sidebar'); editor.classList.add('mail__reader');
        const header = element('header', 'mail__sidebar-header'); header.append(element('h2', 'mail__title', t('title')));
        header.append(button(t('refresh'), () => {void this.reload();}, signal, p.icons.refresh));
        if (this.options.scanners) header.append(button(t('scanners'), () => {void this.options.scanners!().catch(error => this.failure(error, 'scanners.open'));}, signal, p.icons.settings));
        this.source = element('select', 'mail__source'); this.source.setAttribute('aria-label', t('accounts'));
        this.search = element('input', 'mail__search'); this.search.type = 'search'; this.search.placeholder = t('search'); this.search.setAttribute('aria-label', t('search'));
        this.mode = element('select', 'mail__search-mode'); this.mode.setAttribute('aria-label', t('searchMode'));
        for (const value of ['headers', 'content']) {const option = element('option', '', t(value)); option.value = value; this.mode.append(option);}
        this.source.addEventListener('change', () => this.change({sourceId: this.source.value}), {signal});
        this.mode.addEventListener('change', () => this.change({searchMode: this.mode.value as 'headers' | 'content'}), {signal});
        this.search.addEventListener('input', () => {
            this.revision++; clearTimeout(this.timer);
            this.timer = setTimeout(() => this.change({search: this.search.value}), 200);
        }, {signal});
        this.list = element('div', 'mail__list');
        this.alert = element('p', 'mail__alert'); this.alert.setAttribute('role', 'status');
        const pager = element('nav', 'mail__pager'); pager.setAttribute('aria-label', t('pages'));
        this.previous = button(t('previous'), () => this.turn(-1), signal); this.next = button(t('next'), () => this.turn(1), signal);
        this.pageLabel = element('span', 'mail__page'); pager.append(this.previous, this.pageLabel, this.next);
        sidebar.replaceChildren(header, this.source, this.search, this.mode, this.alert, this.list, pager);
        editor.replaceChildren(element('p', 'mail__empty', t('emptyReader')));
    }
    private change(change: Partial<MailQuery>): void {this.query = {...this.query, ...change, page: 1}; this.revision++; void this.refresh();}
    private turn(delta: number): void {this.query.page = Math.max(1, (this.query.page ?? 1) + delta); this.revision++; void this.refresh();}
    private refresh(): Promise<void> {
        if (this.abort.signal.aborted) return Promise.resolve();
        this.dirty = true;
        return this.loading ??= this.drain().finally(() => {this.loading = undefined; if (this.dirty && this.visible && !this.abort.signal.aborted) void this.refresh();});
    }
    private async drain(): Promise<void> {
        while (this.dirty && this.visible && !this.abort.signal.aborted) {
            this.dirty = false; const revision = this.revision;
            this.options.sidebar.setAttribute('aria-busy', 'true');
            try {
                const page = await this.options.client.queryMail({...this.query});
                if (revision !== this.revision || this.abort.signal.aborted) continue;
                this.query.page = page.page; this.render(page);
            } catch (error) {if (revision === this.revision) this.failure(error, 'mail.query');}
            finally {this.options.sidebar.removeAttribute('aria-busy');}
        }
    }
    private render(page: MailPage): void {
        const t = this.options.presentation.text, selected = this.query.sourceId ?? '';
        const all = element('option', '', `${t('all')} (${page.sources.reduce((total, source) => total + source.count, 0)})`); all.value = '';
        this.source.replaceChildren(all);
        const groups = new Map<string, HTMLOptGroupElement>();
        for (const source of page.sources) {
            let group = groups.get(source.providerId);
            if (!group) {group = element('optgroup', ''); group.label = source.provider; groups.set(source.providerId, group); this.source.append(group);}
            const option = element('option', '', `${source.account} · ${source.name} (${source.count})`); option.value = source.id; group.append(option);
        }
        this.source.value = selected; this.list.replaceChildren();
        for (const thread of page.threads) {
            const row = button(thread.subject, () => {void this.openResource(thread.id).catch(error => this.failure(error, 'thread.open'));}, this.abort.signal);
            row.className = 'mail__row'; row.dataset.threadId = thread.id;
            row.replaceChildren(element('strong', 'mail__subject', thread.subject), element('span', 'mail__summary',
                [thread.from, thread.date ? new Date(thread.date).toLocaleString() : '', `${thread.count} ${t('messages')}`].filter(Boolean).join(' · ')));
            row.setAttribute('aria-current', String(this.active === thread.id)); this.list.append(row);
        }
        if (!page.threads.length) this.list.append(element('p', 'mail__empty', t('noResults')));
        const pages = Math.max(1, Math.ceil(page.total / page.pageSize)); this.pageLabel.textContent = `${page.page} / ${pages} · ${page.total} ${t('threads')}`;
        this.previous.disabled = page.page <= 1; this.next.disabled = page.page >= pages;
        this.alert.textContent = page.warnings.length ? t('partial') + ' · ' + page.warnings.join(', ') : '';
    }
    private async reload(): Promise<void> {
        try {await this.options.client.refreshMail(); await this.refresh();} catch (error) {this.failure(error, 'mail.refresh');}
    }
    async openResource(id: string): Promise<void> {
        if (!id || id === '/') return;
        try {
            const active = await this.reader.open(id); if (!active || this.abort.signal.aborted) return;
            this.active = active; this.options.selected?.(active);
            for (const row of this.list.querySelectorAll<HTMLElement>('[data-thread-id]')) row.setAttribute('aria-current', String(row.dataset.threadId === active));
        } catch (error) {this.failure(error, 'thread.open');}
    }
    getActiveResourceId(): string {return this.active;}
    captureRecovery(): unknown {return {...this.query};}
    restoreRecovery(value: unknown): void {
        if (!value || typeof value !== 'object') return;
        const query = value as MailQuery & {source?: string; query?: string};
        this.query = {sourceId: query.sourceId ?? query.source, search: query.search ?? query.query, searchMode: query.searchMode, page: query.page ?? 1};
        this.search.value = this.query.search ?? ''; this.mode.value = this.query.searchMode ?? 'headers'; this.invalidateFromEvents();
    }
    invalidateFromEvents(): void {this.revision++; this.dirty = true; if (this.visible) void this.refresh();}
    setVisible(visible: boolean): void {this.visible = visible; this.reader.setVisible(visible); if (visible && this.dirty) void this.refresh();}
    suspendForRecovery(): void {this.abort.abort(); clearTimeout(this.timer); this.reader.suspend();}
    async destroy(): Promise<void> {this.suspendForRecovery(); await this.loading; await this.reader.destroy(); await this.options.client.dispose();}
    private failure(error: unknown, stage: string): void {
        if (this.abort.signal.aborted) return;
        const raw = (error as {code?: string})?.code ?? (error instanceof Error ? error.message : '');
        const selection = stage === 'thread.selection';
        const code = selection && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : /^(?:MAIL_[A-Z_]+|CALL_TARGET_UNAVAILABLE|SUBMISSION_UNKNOWN|DOCUMENT_CONTEXT_TOO_LARGE|EACCES|EIO|ENOENT|ECONFLICT)$/.test(raw) ? raw : 'MAIL_READ_FAILED';
        this.alert.textContent = this.options.presentation.text(selection ? 'selectionFailed' : 'failed') + ' · ' + code;
        try {this.options.presentation.diagnostic?.({operation: 'mail.view', operationId: this.options.presentation.createOperationId(), stage, result: 'failure', code, durationMs: 0});} catch { /* Diagnostics do not alter UI recovery. */ }
    }
}

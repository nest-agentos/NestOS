import {ContentListView, ContentReader} from '@nestos/mdxeditor';
import {copyText} from '@nestos/ui-common';
import type {MailThreadPage} from '../contracts';
import {element, button, type MailUIOptions} from './ports';
import {messageCard, copyMessage, type MessageView} from './message';
interface View {
    list: ContentListView; page: MailThreadPage; section: HTMLElement; body: HTMLElement; status: HTMLElement; messages: MessageView[];
    more: HTMLButtonElement; fold: HTMLButtonElement; unfold: HTMLButtonElement; abort: AbortController;
}
export class ThreadReader {
    private view?: View;
    private revision = 0;
    private closed = false;
    private readonly pending = new Set<Promise<unknown>>();
    constructor(private readonly options: MailUIOptions, private readonly failure: (error: unknown, stage: string) => void) {}
    open(id: string): Promise<string | undefined> {return this.track(this.prepare(id, ++this.revision));}
    private async prepare(id: string, generation: number): Promise<string | undefined> {
        const page = await this.options.client.readThread({id});
        if (generation !== this.revision || this.closed) return;
        const view = this.mount(page);
        try {await this.append(view, page);}
        catch (error) {await this.release(view); throw error;}
        if (generation !== this.revision || this.closed) {await this.release(view); return;}
        const previous = this.view; this.view = view; this.options.editor.replaceChildren(view.section);
        await this.release(previous); return page.id;
    }
    private mount(page: MailThreadPage): View {
        const {presentation: p} = this.options, abort = new AbortController(), signal = abort.signal;
        const section = element('section', 'mail__thread'), header = element('header', 'mail__thread-header');
        const title = element('h2', 'mail__thread-title', page.subject), actions = element('div', 'mail__actions'), body = element('div', 'mail__thread-body');
        const fold = button(p.text('foldAll'), () => this.expand(view, false), signal, p.icons.fold);
        const unfold = button(p.text('unfoldAll'), () => this.expand(view, true), signal, p.icons.unfold);
        const status = element('p', 'mail__thread-info'); status.setAttribute('role', 'status');
        const more = button(p.text('moreMessages'), () => {void this.track(this.loadMore(view)).catch(error => this.failure(error, 'thread.more'));}, signal);
        const view: View = {list: new ContentListView(body), page, section, body, status, more, fold, unfold, abort, messages: []};
        more.classList.add('mail__more');
        if (this.options.onContentSelection) view.list.configureSelection({label: p.text('selectionAI'),
            run: this.options.onContentSelection, onError: error => this.failure(error, 'thread.selection')});
        actions.append(fold, unfold, button(p.text('copy'), () => {void copyText(view.messages.map(item => copyMessage(item.message, p.text)).join('\n\n---\n\n')).then(ok => {
            if (!ok) throw new Error('MAIL_COPY_FAILED'); if (!signal.aborted) status.textContent = p.text('copied');
        }).catch(error => this.failure(error, 'thread.copy'));}, signal, p.icons.copy));
        header.append(title, actions); section.append(header, status, body, more); this.update(view); return view;
    }
    private async append(view: View, page: MailThreadPage): Promise<void> {
        const added: MessageView[] = [], started = Date.now(), operationId = this.options.presentation.createOperationId();
        try {
            for (const message of page.messages) {
                if (view.abort.signal.aborted || this.closed) break;
                const item = messageCard(message, this.options.presentation, !view.messages.length && !added.length, () => this.update(view));
                added.push(item);
                item.reader = await this.mountReader(item);
                item.content.setCopySource(() => copyMessage(message, this.options.presentation.text), this.options.presentation.text('copyMessage'),
                    () => this.failure(new Error('MAIL_COPY_FAILED'), 'message.copy'));
            }
            if (view.abort.signal.aborted || this.closed) {await this.releaseMessages(added); return;}
            view.messages.push(...added); view.page = page; view.list.sync(view.messages.map(item => ({id: item.message.id, view: item.content}))); this.update(view);
            this.diagnostic(operationId, 'success', started, added.length);
        } catch (error) {
            await this.releaseMessages(added); this.diagnostic(operationId, 'failure', started, added.length, 'MAIL_READER_MOUNT_FAILED');
            throw new Error('MAIL_READER_MOUNT_FAILED', {cause: error});
        }
    }
    private async mountReader(item: MessageView): Promise<import('./ports').MailReader> {
        if (this.options.createReader) return this.options.createReader(item.body, item.message.body, item.message.subject);
        const reader = new ContentReader(item.body, {format: 'text'}); await reader.setText(item.message.body); return reader;
    }
    private async loadMore(view: View): Promise<void> {
        const page = view.page;
        if (!this.hasMore(page) || view.more.disabled || view.abort.signal.aborted) return;
        view.more.disabled = true; view.more.setAttribute('aria-busy', 'true');
        try {
            const next = await this.options.client.readThread({id: page.id, offset: page.nextOffset, revision: page.revision});
            if (view !== this.view || this.closed) return;
            await this.append(view, next);
        } finally {view.more.disabled = false; view.more.removeAttribute('aria-busy');}
    }
    private hasMore(page: MailThreadPage): boolean {return page.nextOffset !== undefined && page.nextOffset < page.total;}
    private expand(view: View, open: boolean): void {view.list.setExpanded(open); this.update(view);}
    private update(view: View): void {
        view.more.hidden = !this.hasMore(view.page);
        view.status.textContent = `${view.messages.length} / ${view.page.total} ${this.options.presentation.text('messages')}`;
        view.fold.disabled = !view.messages.some(item => item.content.getExpanded());
        view.unfold.disabled = !view.messages.some(item => !item.content.getExpanded());
    }
    private diagnostic(operationId: string, result: 'success' | 'failure', started: number, count: number, code?: string): void {
        try {this.options.presentation.diagnostic?.({operation: 'mail.view', operationId, stage: 'thread.readers', result, count, code, durationMs: Date.now() - started});}
        catch { /* Diagnostics do not alter reader lifecycle. */ }
    }
    private track<T>(pending: Promise<T>): Promise<T> {
        this.pending.add(pending); void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending)); return pending;
    }
    private async releaseMessages(messages: MessageView[]): Promise<void> {
        const results = await Promise.allSettled(messages.map(item => Promise.resolve().then(() => item.reader?.destroy()).finally(() => item.content.destroy())));
        const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    }
    private async release(view?: View): Promise<void> {view?.abort.abort(); view?.list.destroy(); if (view) await this.releaseMessages(view.messages);}
    setVisible(visible: boolean): void {this.view?.list.setActive(visible);}
    suspend(): void {this.revision++; this.closed = true; this.view?.abort.abort();}
    async destroy(): Promise<void> {this.suspend(); await Promise.allSettled([...this.pending]); await this.release(this.view); this.view = undefined;}
}

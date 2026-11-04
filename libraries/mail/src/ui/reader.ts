import {copyText} from '@itookit/ui-common';
import type {MailThreadPage} from '../contracts';
import {element, button, type MailUIOptions, type ReaderEditor} from './ports';
interface View {
    page: MailThreadPage; content: string; section: HTMLElement; body: HTMLElement; status: HTMLElement;
    more: HTMLButtonElement; abort: AbortController; editor?: ReaderEditor;
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
        try {view.editor = await this.options.createEditor(view.body, view.content, page.subject);}
        catch (error) {view.abort.abort(); throw error;}
        if (generation !== this.revision || this.closed) {await this.release(view); return;}
        const previous = this.view; this.view = view; this.options.editor.replaceChildren(view.section);
        await this.release(previous); return page.id;
    }
    private mount(page: MailThreadPage): View {
        const {presentation: p} = this.options, abort = new AbortController(), signal = abort.signal;
        const section = element('section', 'mail__thread'), header = element('header', 'mail__thread-header');
        const title = element('h2', 'mail__thread-title', page.subject), actions = element('div', 'mail__actions'), body = element('div', 'mail__thread-body');
        const fold = button(p.text('fold'), () => {body.hidden = true; fold.disabled = true; unfold.disabled = false;}, signal, p.icons.fold);
        const unfold = button(p.text('unfold'), () => {body.hidden = false; fold.disabled = false; unfold.disabled = true;}, signal, p.icons.unfold); unfold.disabled = true;
        const status = element('p', 'mail__thread-info', `${page.messages.length} / ${page.total} ${p.text('messages')}`); status.setAttribute('role', 'status');
        const more = button(p.text('moreMessages'), () => {void this.track(this.loadMore(view)).catch(error => this.failure(error, 'thread.more'));}, signal);
        const view: View = {page, content: this.format(page), section, body, status, more, abort};
        actions.append(fold, unfold, button(p.text('copy'), () => {void copyText(view.content).then(ok => {
            if (!ok) throw new Error('MAIL_COPY_FAILED'); if (!signal.aborted) status.textContent = p.text('copied');
        }).catch(error => this.failure(error, 'thread.copy'));}, signal, p.icons.copy));
        header.append(title, actions); more.hidden = page.nextOffset === undefined;
        section.append(header, status, body, more); return view;
    }
    private async loadMore(view: View): Promise<void> {
        const page = view.page;
        if (page.nextOffset === undefined || view.more.disabled || view.abort.signal.aborted) return;
        view.more.disabled = true;
        try {
            const next = await this.options.client.readThread({id: page.id, offset: page.nextOffset, revision: page.revision});
            if (view !== this.view || this.closed) return;
            const content = view.content + '\n\n---\n\n' + this.format(next), container = element('div', 'mail__editor');
            const editor = await this.options.createEditor(container, content, page.subject);
            if (view !== this.view || this.closed) {await editor.destroy(); return;}
            const previous = view.editor; view.editor = editor; view.body.replaceChildren(container);
            view.content = content; view.page = next; view.more.hidden = next.nextOffset === undefined;
            view.status.textContent = `${next.offset + next.messages.length} / ${next.total} ${this.options.presentation.text('messages')}`;
            await previous?.destroy();
        } finally {view.more.disabled = false;}
    }
    private format(page: MailThreadPage): string {
        const t = this.options.presentation.text;
        return page.messages.map(message => [message.subject, `${t('from')}: ${message.from}`, `${t('to')}: ${message.to}`,
            `${t('account')}: ${message.source.provider} / ${message.source.account}`,
            `${t('date')}: ${message.date ? new Date(message.date).toLocaleString() : ''}`, '', message.body].join('\n')).join('\n\n---\n\n');
    }
    private track<T>(pending: Promise<T>): Promise<T> {
        this.pending.add(pending); void pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending)); return pending;
    }
    private async release(view?: View): Promise<void> {view?.abort.abort(); await view?.editor?.destroy();}
    suspend(): void {this.revision++; this.closed = true; this.view?.abort.abort();}
    async destroy(): Promise<void> {this.suspend(); await Promise.allSettled([...this.pending]); await this.release(this.view); this.view = undefined;}
}

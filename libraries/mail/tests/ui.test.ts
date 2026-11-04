// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {MailWorkbench} from '../src/ui';
import {fixture, write} from './fixture';
import type {MailClient} from '../src/contracts';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks();});
async function ui(count = 25) {
    const f = await fixture(count); cleanup.push(() => f.manager.dispose());
    const client = f.open(), query = vi.spyOn(client, 'queryMail'), read = vi.spyOn(client, 'readThread');
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const destroy = vi.fn(async () => {}), selected = vi.fn();
    const createEditor = vi.fn(async (container: HTMLElement, content: string) => {container.textContent = content; return {getText: () => content, destroy};});
    const options = {client: client as MailClient, sidebar, editor, createEditor, selected,
        presentation: {text: (key: string) => key, createOperationId: () => 'ui-operation', icons: {refresh: '', settings: '', fold: '', unfold: '', copy: ''}}};
    const workbench = new MailWorkbench(options); cleanup.push(() => workbench.destroy());
    return {...f, client, workbench, options, sidebar, editor, createEditor, destroy, selected, query, read};
}
function action(root: HTMLElement, name: string) {return root.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;}
it('loads one twenty-thread page, creates no reader until activation and searches beyond the current page', async () => {
    const f = await ui(); await f.workbench.start();
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(20);
    expect(f.createEditor).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    action(f.sidebar, 'next').click(); await vi.waitFor(() => expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(5));
    const search = f.sidebar.querySelector<HTMLInputElement>('input')!; search.value = 'sender24@'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(1));
    expect(f.sidebar.textContent).toContain('Topic 24'); expect(f.workbench.captureRecovery()).toMatchObject({page: 1, search: 'sender24@'});
    search.value = 'secret0'; search.dispatchEvent(new Event('input'));
    await vi.waitFor(() => expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(0));
    const mode = f.sidebar.querySelector<HTMLSelectElement>('.mail__search-mode')!; mode.value = 'content'; mode.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(1));
    expect(f.sidebar.textContent).toContain('Topic 0'); expect(f.read).not.toHaveBeenCalled();
});
it('renders each subject in one editor with per-message information and fold, unfold and copy controls', async () => {
    const f = await ui(1); await write(f.files, '/first/one/reply.email', 'Subject: Re: Topic 0\nFrom: reply@example.test\n\nSecond body');
    const clipboard = vi.fn(async () => {}); Object.defineProperty(navigator, 'clipboard', {value: {writeText: clipboard}, configurable: true});
    await f.workbench.start(); f.sidebar.querySelector<HTMLButtonElement>('.mail__row')!.click();
    await vi.waitFor(() => expect(f.createEditor).toHaveBeenCalledTimes(1));
    expect(f.editor.textContent).toContain('Second body'); expect(f.editor.textContent).toContain('sender0@example.test');
    expect(f.editor.textContent).toContain('one@example.test'); expect(f.editor.querySelector('script')).toBeNull();
    const body = f.editor.querySelector<HTMLElement>('.mail__thread-body')!;
    action(f.editor, 'fold').click(); expect(body.hidden).toBe(true); action(f.editor, 'unfold').click(); expect(body.hidden).toBe(false);
    action(f.editor, 'copy').click(); await vi.waitFor(() => expect(clipboard).toHaveBeenCalledOnce());
    expect(clipboard.mock.calls[0][0]).toContain('Second body'); expect(clipboard.mock.calls[0][0]).toContain('sender0@example.test');
    await f.workbench.destroy(); expect(f.destroy).toHaveBeenCalledOnce();
});
it('ignores late query responses after changing filters', async () => {
    const f = await ui(1); await f.workbench.start();
    const original = await f.client.queryMail(); let release!: (value: typeof original) => void;
    f.query.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    f.workbench.invalidateFromEvents();
    const search = f.sidebar.querySelector<HTMLInputElement>('input')!; search.value = 'no-match'; search.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 220)); release(original);
    await vi.waitFor(() => expect(f.sidebar.querySelectorAll('.mail__row')).toHaveLength(0));
});
it('waits for a pending editor mount to be released when the view closes', async () => {
    const f = await ui(1); await f.workbench.start();
    let release!: () => void; const held = new Promise<void>(resolve => {release = resolve;});
    f.createEditor.mockImplementationOnce(async () => {await held; return {destroy: f.destroy, getText: () => ''};});
    const opening = f.workbench.openResource('/first/one/0.email');
    await vi.waitFor(() => expect(f.createEditor).toHaveBeenCalledOnce());
    let finished = false; const closing = f.workbench.destroy().then(() => {finished = true;});
    await Promise.resolve(); expect(finished).toBe(false); release(); await Promise.all([opening, closing]);
    expect(f.destroy).toHaveBeenCalledOnce(); expect(f.selected).not.toHaveBeenCalled();
});
it('preserves loaded content and gives a specific reason when a later thread page fails', async () => {
    const f = await ui(1); await f.workbench.start(); await f.workbench.openResource('/first/one/0.email');
    f.read.mockRejectedValueOnce(new Error('MAIL_THREAD_CHANGED')); await f.workbench.openResource('/missing.email');
    expect(f.editor.textContent).toContain('secret0'); expect(f.sidebar.textContent).toContain('MAIL_THREAD_CHANGED');
});

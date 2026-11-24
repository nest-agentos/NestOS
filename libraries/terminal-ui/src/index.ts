import {CommandPanel, type CommandStore} from './commands';
import type {Terminal} from '@xterm/xterm';
import type {FitAddon} from '@xterm/addon-fit';

export interface TerminalSession {
    readOutput(cursor: number): Promise<{output:string;cursor:number;truncated:boolean;exited:boolean;exitCode:number|null}>;
    sendInput(data:string): Promise<void>;
    resizeTerminal(cols:number, rows:number): Promise<void>;
    dispose(): Promise<void>;
}
export interface TerminalPort { openTerminal(): Promise<TerminalSession> }
export type {CommandStore, SavedCommand} from './commands';
const arrows: Record<string, string> = {up: 'A', down: 'B', right: 'C', left: 'D'};
const arrowLabels = {up: '↑', down: '↓', left: '←', right: '→'};
function escapeHTML(value:string):string {
    return value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
}

/** The editor owns only its terminal lease; it never replays input after failure. */
export class TerminalWidget {
    private terminal?: Terminal;
    private fit?: FitAddon;
    private session?: TerminalSession;
    private observer?: ResizeObserver;
    private timer?: ReturnType<typeof setTimeout>;
    private inputTimer?: ReturnType<typeof setTimeout>;
    private pendingInput = '';
    private inputTail = Promise.resolve();
    private cursor = 0;
    private closed = false;
    private active = false;
    private opening = false;
    private panel?: CommandPanel;
    private ctrl = false;
    private alt = false;
    constructor(private readonly container: HTMLElement, private readonly service: TerminalPort | undefined, private readonly translate: (key: string) => string, private readonly storage?: CommandStore, private readonly newId?: () => string) {}
    async render(): Promise<void> {
        this.container.innerHTML = `<div class="terminal-widget">
            <h1 class="terminal-widget__title">${escapeHTML(this.translate('terminal.title'))}</h1>
            <p class="terminal-widget__description">${escapeHTML(this.translate('terminal.description'))}</p>
            <div class="terminal-widget__toolbar">
                ${this.renderKeys()}
                <button class="terminal-widget__button" type="button" data-terminal="commands">${escapeHTML(this.translate('terminal.commands'))}</button>
                <button class="terminal-widget__button" type="button" data-terminal="history">${escapeHTML(this.translate('terminal.history'))}</button>
                <button class="terminal-widget__button" type="button" data-terminal="interrupt" disabled>${escapeHTML(this.translate('terminal.interrupt'))}</button>
                <button class="terminal-widget__button" type="button" data-terminal="clear">${escapeHTML(this.translate('terminal.clear'))}</button>
                <button class="terminal-widget__button" type="button" data-terminal="close" disabled>${escapeHTML(this.translate('terminal.close'))}</button>
                <button class="terminal-widget__button" type="button" data-terminal="open">${escapeHTML(this.translate('terminal.open'))}</button>
            </div><div class="terminal-widget__commands" hidden></div><p class="terminal-widget__status" role="status" aria-live="polite"></p>
            <div class="terminal-widget__screen"></div></div>`;
        if (this.storage && this.newId) this.panel = new CommandPanel(this.container.querySelector('.terminal-widget__commands')!, this.storage, this.translate, this.newId, (value, execute) => this.insertCommand(value, execute), error => this.showError(error));
        this.container.onclick = event => {
            const action = (event.target as HTMLElement).closest<HTMLElement>('[data-terminal]')?.dataset.terminal;
            if (action === 'commands' || action === 'history') void this.panel?.show(action);
            if (action === 'open') void this.open();
            if (action === 'clear') this.terminal?.clear();
            if (action === 'interrupt') this.enqueueInput('\x03');
            if (action === 'close') void this.closeSession().catch(error => this.fail(error));
            if (action === 'ctrl' || action === 'alt') {
                this[action] = !this[action]; this.updateModifiers(); this.terminal?.focus();
            }
            if (action === 'escape' || action === 'tab') this.sendKey(action === 'escape' ? '\x1b' : '\t');
            if (action && Object.hasOwn(arrows, action)) this.sendArrow(arrows[action]!);
        };
        if (this.service) await this.open();
        else { this.status(this.translate('terminal.unavailable')); this.buttons(false); }
    }
    private renderKeys(): string {
        const button = (key: string, label: string, pressed = false) =>
            `<button class="terminal-widget__button" type="button" data-terminal="${key}" disabled aria-label="${escapeHTML(this.translate('terminal.key.' + key))}" ${pressed ? 'aria-pressed="false"' : ''}>${label}</button>`;
        return `<div class="terminal-widget__keys" role="group" aria-label="${escapeHTML(this.translate('terminal.keys'))}">
            ${button('ctrl', 'Ctrl', true)}${button('alt', 'Alt', true)}${button('escape', 'Esc')}${button('tab', 'Tab')}
            ${Object.entries(arrowLabels).map(([key, label]) => button(key, label)).join('')}</div>`;
    }
    private updateModifiers(): void {
        for (const key of ['ctrl', 'alt'] as const) {
            this.container.querySelector(`[data-terminal="${key}"]`)?.setAttribute('aria-pressed', String(this[key]));
        }
    }
    private resetModifiers(): void {
        this.ctrl = this.alt = false;
        this.updateModifiers();
    }
    private sendKey(data: string): void {
        this.enqueueInput(this.keyInput(data)); this.terminal?.focus();
    }
    private keyInput(data: string): string {
        const {ctrl, alt} = this;
        this.resetModifiers();
        if (data.length !== 1) return data;
        const code = data.toUpperCase().charCodeAt(0);
        const control = ctrl && (data === ' ' || data === '?' || (data.charCodeAt(0) < 128 && code >= 64 && code <= 95));
        const key = control ? String.fromCharCode(data === '?' ? 127 : code & 31) : data;
        return alt ? '\x1b' + key : key;
    }
    private sendArrow(key: string): void {
        const modifier = 1 + Number(this.alt) * 2 + Number(this.ctrl) * 4;
        this.resetModifiers();
        const prefix = modifier > 1 ? `\x1b[1;${modifier}` : this.terminal?.modes?.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
        this.sendKey(prefix + key);
    }
    private async open(): Promise<void> {
        if (!this.service || this.closed || this.opening || this.active) return;
        this.opening = true; this.buttons(false); this.status(this.translate('terminal.connecting'));
        try {
            await this.closeSession();
            const [{Terminal}, {FitAddon}] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
            if (this.closed) return;
            const session = await this.service.openTerminal();
            if (this.closed) { await session.dispose(); return; }
            this.session = session; this.cursor = 0;
            this.terminal?.dispose();
            this.terminal = new Terminal({cursorBlink: true, scrollback: 3000, fontSize: 14, allowProposedApi: false});
            this.fit = new FitAddon(); this.terminal.loadAddon(this.fit);
            this.terminal.open(this.container.querySelector<HTMLElement>('.terminal-widget__screen')!);
            this.active = true;
            this.terminal.onData(data => this.enqueueInput(this.ctrl || this.alt ? this.keyInput(data) : data));
            this.observer = new ResizeObserver(() => this.resize());
            this.observer.observe(this.container.querySelector('.terminal-widget__screen')!);
            this.resize(); this.terminal.focus(); this.status(this.translate('terminal.connected'));
            this.buttons(true); void this.poll();
        } catch (error) { this.fail(error); }
        finally { this.opening = false; this.buttons(this.active); }
    }
    private resize(): void {
        if (!this.active || !this.session || !this.terminal) return;
        const size = this.fit?.proposeDimensions();
        if (!size || size.cols < 2 || size.rows < 2) return;
        const cols = Math.min(500, size.cols), rows = Math.min(500, size.rows);
        if (cols === this.terminal.cols && rows === this.terminal.rows) return;
        this.terminal.resize(cols, rows);
        const session = this.session;
        void session.resizeTerminal(cols, rows).catch(error => { if (this.session === session && this.active) this.fail(error); });
    }
    private enqueueInput(data: string): void {
        if (!this.active) return;
        this.pendingInput += data;
        if (this.pendingInput.length > 65536) { this.pendingInput = ''; this.fail(new Error(this.translate('terminal.inputLimit'))); return; }
        if (!this.inputTimer) this.inputTimer = setTimeout(() => this.flushInput(), 20);
    }
    private flushInput(): void {
        this.inputTimer = undefined;
        const data = this.pendingInput, session = this.session; this.pendingInput = '';
        if (!data || !session || !this.active) return;
        this.inputTail = this.inputTail.then(async () => {
            let start = 0;
            while (start < data.length && this.active && this.session === session) {
                let end = Math.min(start + 2048, data.length);
                if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
                await session.sendInput(data.slice(start, end)); start = end;
            }
        }).catch(error => this.fail(error));
    }
    private async poll(): Promise<void> {
        const session = this.session;
        if (!this.active || !session || this.closed) return;
        try {
            const page = await session.readOutput(this.cursor);
            if (this.session !== session || !this.active || this.closed) return;
            this.cursor = page.cursor;
            if (page.truncated) { this.terminal?.reset(); this.status(this.translate('terminal.truncated')); }
            if (page.output && this.terminal) await new Promise<void>(resolve => this.terminal!.write(page.output, resolve));
            if (this.session !== session || !this.active || this.closed) return;
            if (page.exited) { this.active = false; this.buttons(false); this.status(`${this.translate('terminal.exited')}: ${page.exitCode ?? '—'}`); return; }
            this.timer = setTimeout(() => void this.poll(), page.output.length >= 32768 ? 0 : 150);
        } catch (error) { if (this.session === session && !this.closed) this.fail(error); }
    }
    private insertCommand(command: string, execute: boolean): void {
        if (!this.active || !this.terminal) { this.showError(new Error(this.translate('terminal.commandNeedsSession'))); return; }
        if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) { this.showError(new Error(this.translate('terminal.commandInvalidCharacters'))); return; }
        if (!this.terminal.modes.bracketedPasteMode) { this.showError(new Error(this.translate('terminal.pasteUnavailable'))); return; }
        this.resetModifiers();
        this.terminal.paste(command); if (execute) this.enqueueInput('\r'); this.terminal.focus();
    }
    private showError(error: unknown): void { this.status(`${this.translate('terminal.failed')}: ${error instanceof Error ? error.message : String(error)}`); }
    private fail(error: unknown): void {
        if (this.closed) return;
        this.active = false; this.buttons(false);
        this.status(`${this.translate('terminal.failed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
    private status(message: string): void {
        const status = this.container.querySelector('.terminal-widget__status');
        if (status) status.textContent = message;
    }
    private buttons(active: boolean): void {
        if (!active) this.resetModifiers();
        for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-terminal]')) {
            const action = button.dataset.terminal;
            if (action === 'open') button.hidden = active;
            button.disabled = action === 'open' ? !this.service || active || this.opening :
                action === 'clear' ? false : action === 'commands' || action === 'history' ? !this.panel : action === 'close' ? !this.session : !active;
        }
    }
    private async closeSession(): Promise<void> {
        this.active = false; clearTimeout(this.timer); clearTimeout(this.inputTimer);
        this.resetModifiers();
        this.pendingInput = ''; this.inputTimer = undefined; this.observer?.disconnect();
        const session = this.session; this.session = undefined;
        await this.inputTail;
        await session?.dispose();
        if (!this.closed) { this.status(this.translate('terminal.closed')); this.buttons(false); }
    }
    async destroy(): Promise<void> {
        this.closed = true; this.container.onclick = null;
        try { await this.closeSession(); }
        finally { this.terminal?.dispose();  }
    }
}

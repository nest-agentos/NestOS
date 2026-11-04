import type {MailClient, MailDiagnostic} from '../contracts';
export interface MailReader {destroy(): Promise<void>;}
export interface MailPresentation {
    locale?: 'zh-CN' | 'en';
    text(key: string): string;
    icons: {refresh: string; settings: string; fold: string; unfold: string; copy: string};
    diagnostic?(record: MailDiagnostic): void;
    createOperationId(): string;
}
export interface MailUIOptions {
    onContentSelection?(selection: import('@nestos/mdxeditor').ContentSelection, signal: AbortSignal): Promise<void>;
    client: MailClient; sidebar: HTMLElement; editor: HTMLElement; presentation: MailPresentation;
    createReader?(container: HTMLElement, content: string, title: string): Promise<MailReader>;
    selected?(id: string): void; scanners?(): Promise<void>;
}
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
}
export function button(label: string, run: () => void, signal: AbortSignal, icon?: string): HTMLButtonElement {
    const node = element('button', 'mail__button'); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    if (icon) {const glyph = element('span', 'mail__icon'); glyph.innerHTML = icon; glyph.setAttribute('aria-hidden', 'true'); node.append(glyph);}
    else node.textContent = label;
    node.addEventListener('click', run, {signal}); return node;
}

// @vitest-environment jsdom
import type {ConversationSnapshot} from '../contracts';
import {afterEach, expect, it, vi} from 'vitest';
import {t} from '@nestos/common';
import {ConversationInformation} from './ConversationInformation';

afterEach(() => document.body.replaceChildren());
const state: ConversationSnapshot = {title: 'Native', messages: [], requests: [], pending: false, gap: false, disconnected: false,
    canSend: true, canInterrupt: false, canRespond: false, supportsMetrics: true};
function mockDialog(): void {
    Object.defineProperties(HTMLDialogElement.prototype, {
        showModal: {configurable: true, value(this: HTMLDialogElement) {this.open = true;}},
        close: {configurable: true, value(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));}},
    });
}
it('shows the native execution model and leaves missing reasoning unreported', () => {
    mockDialog();
    const information = new ConversationInformation(document.body);
    information.mountInlineModel(document.body);
    const inline = document.querySelector<HTMLButtonElement>('.remote-conversation-info__model')!;
    information.setSnapshot({...state, supportsModels: true});
    expect(inline.hidden).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-action=conversation-information]')!.click();
    const values = () => Array.from(document.querySelectorAll('[data-session-info-executed-model] dd'), row => row.textContent);
    const unknown = t('harness.executionValueUnknown');
    expect(values()).toEqual([unknown, unknown]);
    information.setSnapshot({...state, executedModel: {modelId: 'claude-sonnet-4-6'}});
    expect(values()).toEqual(['claude-sonnet-4-6', unknown]);
    information.setSnapshot({...state, executedModel: {providerId: 'openai', modelId: 'gpt-example', reasoningEffort: 'high'}});
    expect(values()).toEqual(['openai / gpt-example', 'high']);
    expect(inline.hidden).toBe(false);
    expect(inline.textContent).toBe('gpt-example · high');
    information.destroy();
});
it('loads metrics only on opening or explicit refresh, keeps failure local and ignores a closed dialog response', async () => {
    mockDialog();
    const read = vi.fn(async () => ({...state, metrics: {observedAt: 1793440000000, contextWindow: {usedTokens: 1000, limitTokens: 200000}}}));
    const information = new ConversationInformation(document.body, read); information.setSnapshot(state);
    expect(read).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-action=conversation-information]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-session-info-metrics]')!.textContent).toContain('1,000 / 200,000'));
    expect(read).toHaveBeenCalledOnce();
    read.mockRejectedValue(Object.assign(new Error('private native response'), {code: 'ETIMEDOUT'}));
    document.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-session-info-metrics]')!.textContent).toContain('ETIMEDOUT'));
    expect(document.querySelector('[data-session-info-metrics]')!.textContent).not.toContain('private native response');
    expect(state.canSend).toBe(true);
    let finish!: (value: Awaited<ReturnType<typeof read>>) => void;
    read.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    document.querySelector<HTMLButtonElement>('[data-action=refresh-native-metrics]')!.click();
    information.destroy(); finish({...state, metrics: {observedAt: 1793440000000, contextWindow: {usedTokens: 5000, limitTokens: 200000}}});
    await Promise.resolve(); expect(document.querySelector('dialog')).toBeNull();
});

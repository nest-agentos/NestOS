// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {LegacyPromptCommands} from './legacy-prompt-commands';

it('intercepts legacy input, recalls without sending and navigates duplicate messages by identity', async () => {
    const root = document.createElement('div'), focus = vi.fn(), reveal = vi.fn(); let text = '/history', revision = 0;
    const context = {container: root, getText: () => text, getDraftRevision: () => revision,
        setText: (value: string) => {text = value; revision++;}, focus} as never;
    const message = (id: string) => ({id, revision: 0, role: 'user' as const, state: 'complete' as const, timestamp: 1000,
        parts: [{id: 'text', kind: 'markdown' as const, text: 'same'}]});
    const port = {listSaved: vi.fn(async () => ['saved']), savePrompt: vi.fn(async () => {})};
    const plugin = new LegacyPromptCommands(() => port, () => [message('first'), message('second')], reveal, async () => {}, () => false);
    plugin.activate(context); expect(plugin.onBeforeSend(text)).toBe(false);
    root.querySelectorAll('.llm-composer-history > div')[0].querySelectorAll('button')[1].click();
    expect(reveal).toHaveBeenCalledWith('second', 'same'); expect(text).toBe('/history');
    text = '/prompt'; expect(plugin.onBeforeSend(text)).toBe(false);
    await vi.waitFor(() => expect(root.textContent).toContain('saved'));
    [...root.querySelectorAll('button')].find(button => button.textContent === 'saved')!.click();
    expect(text).toBe('saved'); expect(focus).toHaveBeenCalled();
    text = '/prompt new'; expect(plugin.onBeforeRemoteSend(text)).toBe(false);
    await vi.waitFor(() => expect(port.savePrompt).toHaveBeenCalledWith('new', expect.any(String)));
    plugin.deactivate();
});

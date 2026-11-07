// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createSettingsFactory, type SettingsFactoryOptions, type LLMUIEditors} from '@nestos/app-settings';

it('loads injected settings editors only for their pages and retries failed loading', async () => {
    const init = vi.fn(async () => {}), created = vi.fn();
    class Editor {constructor(...args: unknown[]) {created(...args);} init = init;}
    const editors = Object.fromEntries(['ModelDefaultsEditor','ProviderSettingsEditor','ConnectionSettingsEditor','MCPSettingsEditor','CostEditor','SystemPromptSettingsEditor'].map(key => [key,Editor])) as unknown as LLMUIEditors;
    const load = vi.fn(async () => editors);
    const factory = createSettingsFactory({llmUiEditors:load} as unknown as SettingsFactoryOptions);
    const element = document.createElement('main');
    const options = (id: string) => ({target:{kind:'configuration' as const,id}});
    await factory(element, options('unknown') as never); expect(load).not.toHaveBeenCalled();
    load.mockRejectedValueOnce(new Error('MODULE_UNAVAILABLE'));
    await expect(factory(element, options('providers') as never)).rejects.toThrow('MODULE_UNAVAILABLE');
    expect(created).not.toHaveBeenCalled();
    await factory(element, options('providers') as never);
    expect(load).toHaveBeenCalledTimes(2); expect(init).toHaveBeenCalledOnce();
    expect(created.mock.calls[0][0]).toBe(element);
});

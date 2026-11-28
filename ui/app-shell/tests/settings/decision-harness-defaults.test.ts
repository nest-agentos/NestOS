// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createSettingsFactory, type SettingsFactoryOptions} from '@nestos/app-settings';
import {mountDecisionHarnessSettings} from '../../src/kanban/model-defaults-section';

it('edits the chosen board’s decision default through the existing revision-checked command', async () => {
    const board = {id:'board', title:'Board', revision:7, settings:{'harness-decision':'codex', 'harness-execution':'dsh'}};
    const service = {
        catalog: vi.fn(async () => [board, {id:'other', title:'Other'}]),
        boardSettings: vi.fn(async () => ({fields:[
            {name:'harness-decision', label:'Decision', choices:[
                {value:'', label:'Auto'}, {value:'codex', label:'Codex'}, {value:'agy', label:'Antigravity'},
            ]},
            {name:'harness-execution',label:'Execution',choices:[]},
        ]})),
        execute: vi.fn(async () => ({...board, revision:8})).mockRejectedValueOnce(Object.assign(new Error('Unknown receipt'), {
            code:'ETIMEDOUT', outcome:'unknown',
        })),
    };
    class Editor { async init(host: HTMLElement) { host.textContent = 'Models'; } async destroy() {} }
    const section = vi.fn(async (host: HTMLElement) => mountDecisionHarnessSettings(host, service as never));
    const factory = createSettingsFactory({llmUiEditors:{ModelDefaultsEditor:Editor}, modelDefaultsSection:section} as unknown as SettingsFactoryOptions);
    const host = document.createElement('div');
    const editor = await factory(host, {target:{kind:'configuration',id:'model-defaults'}} as never);
    await vi.waitFor(() => expect(host.querySelector('option[value=board]')).toBeTruthy());
    expect(host.firstElementChild?.querySelector('option[value=board]')).toBeTruthy();
    expect(service.boardSettings).not.toHaveBeenCalled();
    const select = host.querySelector('select')!;
    select.value='board'; select.dispatchEvent(new Event('change'));
    const field = () => host.querySelector<HTMLSelectElement>('select[name=setting-harness-decision]')!;
    await vi.waitFor(() => expect(field()?.value).toBe('codex'));
    expect(host.querySelector('[name=setting-harness-execution], [name=executionSlots]')).toBeNull();
    field().value = 'agy';
    field().form!.dispatchEvent(new Event('submit', {cancelable:true}));
    await vi.waitFor(() => expect(service.execute).toHaveBeenCalledWith('board', {
        operationId: expect.any(String), expectedRevision:7,
        command:{type:'configure-board-settings',settings:{'harness-decision':'agy','harness-execution':'dsh'}},
    }));
    await vi.waitFor(() => expect(host.querySelector('[role=alert]')?.textContent).toContain('ETIMEDOUT'));
    expect(field().disabled).toBe(true);
    field().form!.dispatchEvent(new Event('submit', {cancelable:true}));
    await vi.waitFor(() => expect(field().disabled).toBe(false));
    expect(service.execute.mock.calls[1]).toEqual(service.execute.mock.calls[0]);
    await editor.destroy();
    expect(host.children).toHaveLength(0);
});

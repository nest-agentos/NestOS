// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createAgentScopeEditor} from '../src/projects/agent-scope-editor';

it('uses configuration/project tabs, searchable checkboxes, collapsed all-projects and stable project IDs', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const saveAgentProjectScope = vi.fn(async () => {}), changed = vi.fn();
    const backend = {readAgentProjectScopes: async () => ({a: {kind: 'all'}}), saveAgentProjectScope};
    const projects = {list: async () => [{name: 'Alpha', project: {id: 'stable-a'}}, {name: 'Beta', project: {id: 'stable-b'}}]};
    const editor = await createAgentScopeEditor(root, 'a', backend as never, projects as never, async container => {
        container.textContent = 'config'; return {isDirty: () => false, flushPendingSave: async () => {}, destroy: async () => {}} as never;
    }, changed);
    try {
        const tabs = root.querySelectorAll<HTMLButtonElement>('[role=tab]'); expect(tabs).toHaveLength(2); tabs[1].click();
        const search = root.querySelector<HTMLInputElement>('input[type=search]')!; expect(search.hidden).toBe(true);
        const radios = root.querySelectorAll<HTMLInputElement>('input[type=radio]'); radios[1].click(); expect(search.hidden).toBe(false);
        search.value = 'beta'; search.dispatchEvent(new Event('input'));
        expect(root.querySelector<HTMLInputElement>('input[value=stable-a]')!.parentElement!.hidden).toBe(true);
        root.querySelector<HTMLInputElement>('input[value=stable-b]')!.click(); await editor.flushPendingSave!();
        expect(saveAgentProjectScope).toHaveBeenLastCalledWith('a', {kind: 'selected', projectIds: ['stable-b']});
        radios[0].click(); await editor.flushPendingSave!(); expect(search.hidden).toBe(true);
        expect(saveAgentProjectScope).toHaveBeenLastCalledWith('a', {kind: 'all'});
    } finally {await editor.destroy(); root.remove();}
});

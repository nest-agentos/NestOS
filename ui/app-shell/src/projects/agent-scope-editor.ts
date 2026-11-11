import {randomUUID, t} from '@nestos/common';
import {SettingsAutoSave, type IEditor} from '@nestos/ui-common-adapter';
import type {ApplicationBackend, AgentProjectScope, ProjectService} from '@nestos/app-contracts/services';

type HostSettings = NonNullable<import('@nestos/ui-common-adapter').EditorOptions['mountSettings']>;
type Project = Awaited<ReturnType<ProjectService['list']>>[number];
function mountTabs(mount: HTMLElement, panels: HTMLElement[]): (selected: number) => void {
    const prefix = randomUUID(), tabs = document.createElement('nav'); tabs.setAttribute('role', 'tablist');
    const buttons = (['configuration', 'project'] as const).map((key, index) => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t(`agentWorkspace.${key}`);
        button.id = `${prefix}-tab-${index}`; button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', `${prefix}-panel-${index}`);
        panels[index].id = `${prefix}-panel-${index}`; panels[index].setAttribute('role', 'tabpanel');
        panels[index].setAttribute('aria-labelledby', button.id); tabs.append(button); return button;
    });
    const activate = (selected: number) => panels.forEach((panel, index) => {
        panel.hidden = index !== selected; buttons[index].setAttribute('aria-selected', String(index === selected));
        buttons[index].tabIndex = index === selected ? 0 : -1;
    });
    buttons.forEach((button, index) => {
        button.onclick = () => activate(index);
        button.onkeydown = event => {if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
            activate(next); buttons[next].focus();
        }};
    });
    mount.append(tabs, ...panels); activate(0); return activate;
}
function projectChoices(policy: HTMLElement, choices: Project[], selected: Set<string>, radios: HTMLInputElement[]): void {
    const list = document.createElement('div'), search = document.createElement('input'); search.type = 'search';
    search.placeholder = t('agentWorkspace.searchProjects'); search.setAttribute('aria-label', search.placeholder);
    const items = choices.map(project => {
        const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
        input.value = project.project.id; input.checked = selected.has(input.value); label.append(input, project.displayName ?? project.name);
        input.onchange = () => {if (input.checked) selected.add(input.value); else selected.delete(input.value);}; list.append(label); return label;
    });
    search.oninput = () => items.forEach(item => {item.hidden = !item.textContent?.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());});
    const update = () => {search.hidden = list.hidden = !radios[1].checked;}; radios.forEach(input => input.onchange = update); update();
    policy.append(search, list);
}
function scopeForm(policy: HTMLElement, scope: AgentProjectScope, choices: Project[]): () => AgentProjectScope {
    const selected = new Set(scope.kind === 'selected' ? scope.projectIds : []), prefix = randomUUID();
    const radios = (['all', 'selected'] as const).map(kind => {
        const label = document.createElement('label'), input = document.createElement('input'); input.type = 'radio'; input.name = `${prefix}-scope`;
        input.value = kind; input.checked = scope.kind === kind; label.append(input, t(`agentWorkspace.${kind}Projects`)); policy.append(label); return input;
    });
    projectChoices(policy, choices, selected, radios);
    return () => {
        if (radios[1].checked && !selected.size) throw new Error(t('agentWorkspace.selectOne'));
        return radios[1].checked ? {kind: 'selected', projectIds: [...selected]} : {kind: 'all'};
    };
}
function coordinateEditor(editor: IEditor, saves: SettingsAutoSave, activate: (selected: number) => void): IEditor {
    const flush = async () => {
        if (!await saves.flush()) {activate(1); throw new Error(t('settings.autosave.leaveFailed'));}
        await editor.flushPendingSave?.();
    };
    return new Proxy(editor, {get(target, key) {
        if (key === 'flushPendingSave') return flush;
        if (key === 'isDirty') return () => target.isDirty() || saves.isDirty;
        if (key === 'destroy') return async () => {await flush(); await saves.dispose(); await target.destroy();};
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    }});
}
/** Keep project policy in the host while the portable editor owns configuration. */
export async function createAgentScopeEditor(mount: HTMLElement, id: string, backend: ApplicationBackend,
    projects: ProjectService, create: (container: HTMLElement, mountSettings: HostSettings) => Promise<IEditor>, changed: () => void, viewSessions?: () => Promise<void>): Promise<IEditor> {
    const [scopes, choices] = await Promise.all([backend.readAgentProjectScopes([id]), projects.list()]);
    const configuration = document.createElement('div'), policy = document.createElement('div');
    mount.classList.add('agent-scope-editor'); configuration.className = 'agent-scope-editor__configuration';
    policy.className = 'agent-project-settings';
    const activate = mountTabs(mount, [configuration, policy]), read = scopeForm(policy, scopes[id] ?? {kind: 'all'}, choices);
    const error = document.createElement('p'); error.setAttribute('role', 'status'); policy.append(error);
    const saves = new SettingsAutoSave(policy, async () => {
        try {await backend.saveAgentProjectScope(id, read()); error.textContent = ''; changed();}
        catch (cause) {error.textContent = cause instanceof Error ? cause.message : t('settings.autosave.leaveFailed'); throw cause;}
    });
    const hostSettings: HostSettings = async () => ({isDirty: () => saves.isDirty,
        flush: async () => {if (!await saves.flush()) {activate(1); throw new Error(t('settings.autosave.leaveFailed'));}}, destroy: async () => {}});
    if (viewSessions) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = 'show-agent-sessions';
        button.textContent = t('agentWorkspace.viewSessions'); button.onclick = () => {void saves.flush().then(async saved => {if (saved) await viewSessions();}).catch(cause => {error.textContent = String(cause);});}; policy.append(button);
    }
    try {return coordinateEditor(await create(configuration, hostSettings), saves, activate);}
    catch (error) {await saves.dispose(); throw error;}
}

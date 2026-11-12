import {resolveKanbanConfiguration} from './kanban-configuration-files';
import {t} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanAutomationTarget, KanbanBoard} from '@nestos/kanban/contracts';
import {freezePrompts, failure, type PromptJournal, type PromptBundle} from '../run/prompt-bundle';

export interface DevelopmentPolicy {
    version: 1; profile: string; commit: 'changes' | 'worktree'; modules: string[]; prompts: PromptBundle;
}
export function developmentCatalog(): KanbanAutomationTarget[] {
    return [{reference: {system: 'nestos-work-preparation', id: 'git-worktree', revision: '1'}, label: t('kanban.gitWorktree'), options: [
        {name: 'profile', label: t('kanban.developmentProfile'), defaultValue: 'development'},
        {name: 'commit', label: t('kanban.commitPolicy'), defaultValue: 'worktree', choices: [
            {value: 'worktree', label: t('kanban.commitWorktree')}, {value: 'changes', label: t('kanban.commitChanges')}]},
        {name: 'modules', label: t('kanban.developmentModules'), defaultValue: ''}]}];
}

export async function developmentPolicy(journal: PromptJournal, fs: IFileSystem, project: IFileSystem, id: string,
    options: Record<string, string> = {}): Promise<DevelopmentPolicy> {
    const key = 'development-policy:' + id, old = await journal.get<DevelopmentPolicy>(key); if (old) return old;
    const {profile, commit, modules} = validateDevelopmentOptions(options);
    const prompts = await freezePrompts(journal, 'development-prompts:' + id, () => resolveKanbanConfiguration(fs, project, profile));
    return journal.update<DevelopmentPolicy>(key, previous => previous ?? {version: 1, profile, commit: commit as DevelopmentPolicy['commit'], modules, prompts});
}
export function validateDevelopmentOptions(options: Record<string, string> = {}) {
    const profile = options.profile || 'development', commit = options.commit || 'worktree';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile) || !['changes', 'worktree'].includes(commit)
        || Object.keys(options).some(key => !['profile', 'commit', 'modules'].includes(key))) throw failure('DEVELOPMENT_POLICY_INVALID');
    const modules = (options.modules ?? '').split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (modules.length > 32 || new Set(modules).size !== modules.length || modules.some(path => !validModulePath(path))) throw failure('MODULE_PATH_INVALID');
    return {profile, commit: commit as DevelopmentPolicy['commit'], modules};
}
export function validModulePath(path: string): boolean {
    return path.length <= 512 && path.split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part));
}
export function requiresDevelopmentProject(board:KanbanBoard):boolean {
    return board.automation?.preparation?.system==='nestos-work-preparation'&&board.automation.preparation.id==='git-worktree';
}

import {t} from '@nestos/common';
import type {KanbanAutomationTarget} from '@nestos/kanban/contracts';
export function developmentCatalog(): KanbanAutomationTarget[] {
    return [{reference: {system: 'nestos-work-preparation', id: 'git-worktree', revision: '1'}, label: t('kanban.gitWorktree'), options: [
        {name: 'profile', label: t('kanban.developmentProfile'), defaultValue: 'development'},
        {name: 'commit', label: t('kanban.commitPolicy'), defaultValue: 'worktree', choices: [
            {value: 'worktree', label: t('kanban.commitWorktree')}, {value: 'changes', label: t('kanban.commitChanges')}]},
        {name: 'modules', label: t('kanban.developmentModules'), defaultValue: ''}]}];
}


import {t} from '@nestos/common';
import type {UserEventService} from '../events/service';
import type {KanbanWorkLogOptions} from '@nestos/kanban/integration';
import {kanbanJournalOptions} from './host-policy';

export const kanbanReferences = {resource:'nestos-remote-project',decision:'nestos-decision-run',execution:'nestos-execution-session',nativeExecution:'nestos-native-session',workspace:'nestos-worktree'};
export function workLogOptions(events?: Pick<UserEventService,'journal'>, diagnostic?: KanbanWorkLogOptions['diagnostic']): KanbanWorkLogOptions {
    return {directory:kanbanJournalOptions.directory,references:kanbanReferences,diagnostic,
        label: stage => {const key = ('kanban.activity.' + stage) as Parameters<typeof t>[0], label = t(key); return label === key ? stage : label;},
        ...(events ? {onRecord:async ({boardId,itemId,record}) => {
            await events.journal.append('work-log:' + record.id,{type:'kanban.activity',operationId:record.activity?.dispatchId ?? record.id,
                resourceId:'kanban:' + JSON.stringify(['personal:user-store',boardId,itemId])});
        }} : {}),
    };
}

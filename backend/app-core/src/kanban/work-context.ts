import {workContext as projectContext,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import {kanbanReferences} from './work-log-policy';
export async function workContext(journal:KanbanAutomationJournal,board:KanbanBoard,item:KanbanItem) {
    const {resources,...context}=await projectContext(journal,board,item,kanbanReferences);
    return {...context,projects:resources};
}

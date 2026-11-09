import {findRetainedExecution} from '@nestos/kanban/integration';
import type {KanbanDispatch,KanbanWorkflowState} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DevelopmentWorkspaceRecord} from '../presets/kanban-development';
/** Failed preparation may have no workspace or Session; only follow its explicit predecessor chain. */
export async function recoveryWorkspace(journal:KanbanAutomationJournal,workflow:KanbanWorkflowState,dispatch:KanbanDispatch|undefined) {
    const retained=await findRetainedExecution(workflow,dispatch,async candidate=>{
        const record=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+candidate.id);
        return record&&candidate.executionSessionId?record:undefined;
    });
    return retained?{dispatch:retained.dispatch,record:retained.resource}:undefined;
}

import type {KanbanDispatch,KanbanWorkflowState} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DevelopmentWorkspaceRecord} from '../presets/kanban-development';
/** Failed preparation may have no workspace or Session; only follow its explicit predecessor chain. */
export async function recoveryWorkspace(journal:KanbanAutomationJournal,workflow:KanbanWorkflowState,dispatch:KanbanDispatch|undefined) {
    let current=dispatch;const seen=new Set<string>();
    while(current&&!seen.has(current.id)) {
        seen.add(current.id);
        const record=await journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+current.id);
        if(record&&current.executionSessionId)return {dispatch:current,record};
        const previous=current.continuation?workflow.dispatches[current.continuation.previousDispatchId]:undefined;
        if(current.outcome!=='failed'||!previous||previous.itemId!==dispatch!.itemId||previous.executionEpoch!==dispatch!.executionEpoch)return undefined;
        current=previous;
    }
    return undefined;
}

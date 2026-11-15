import {currentAnalysis,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {kanbanTaskType,type KanbanItem} from '@nestos/kanban/contracts';
export const retainedManagementDirectory='WORKTREE_MANAGEMENT_SESSION_RETAINED';
/** Management Session lifetime is independent of the execution worktrees it coordinated. */
export async function managementWorkspaceRetained(journal:KanbanAutomationJournal,boardId:string,resource:{id:string;item:KanbanItem;tree:{archivedAt?:number}}):Promise<boolean> {
    if(resource.tree.archivedAt!==undefined)return false;
    const conversation=await journal.get<{clearedAt?:number;binding?:{retainedPlanning?:boolean}}>('record-conversation:'+resource.id);
    if(conversation?.clearedAt!==undefined)return false;
    if(conversation?.binding?.retainedPlanning)return true;
    return kanbanTaskType(resource.item)==='coordination'&&(await currentAnalysis(journal,boardId,resource.item.id))?.id===resource.id;
}

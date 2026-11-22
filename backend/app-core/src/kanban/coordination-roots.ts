import type {KanbanProjectRecord,KanbanRecordExecution} from '@nestos/kanban/contracts';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {requireValue} from './validation';

/** A retained management Session is fenced to the run that created it. */
export async function coordinationRoots(options:DecisionConversationOptions,conversation:DecisionConversation,record:KanbanProjectRecord,boardId:string):Promise<string[]> {
    const workspace=await options.journal.get<{context?:{decision?:{runId?:string;recordId?:string;sourceBoardId?:string}}}>('development-workspace:'+conversation.id);
    const decision=workspace?.context?.decision;if(!decision?.runId)return record.itemIds;
    requireValue(decision.recordId===record.id&&decision.sourceBoardId===boardId,'ITEM_NOT_IN_DECISION');
    const run=await options.journal.run<KanbanRecordExecution>(boardId,decision.runId);
    requireValue(run&&run.recordId===record.id&&run.boardId===boardId&&run.rootItemId,'ITEM_NOT_IN_DECISION');return [run!.rootItemId!];
}

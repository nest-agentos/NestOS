import {workContext as projectContext,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanItem} from '@nestos/kanban/contracts';
import {kanbanReferences} from './work-log-policy';
export async function workContext(journal:KanbanAutomationJournal,board:KanbanBoard,item:KanbanItem,service?:Pick<import('@nestos/kanban/contracts').KanbanService,'record'>) {
    const {resources,...context}=await projectContext(journal,board,item,kanbanReferences);
    const current=service&&context.decision?await service.record(context.decision.sourceBoardId,context.decision.recordId).catch(error=>{if((error as {code?:string}).code==='RECORD_NOT_FOUND')return undefined;throw error;}):undefined;
    const amendment=current&&context.decision&&current.revision>context.decision.recordRevision?current:undefined;
    return {...context,...(context.decision&&amendment?{decision:{...context.decision,amendment}}:{}),projects:resources};
}

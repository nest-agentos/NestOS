import type {KanbanService, KanbanPlanningSession} from '@nestos/kanban/contracts';
import {currentCoordination,currentAnalysis, type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';

/** Resolve only the current planning call; opening a decision never enumerates session history. */
export function planningSessionReader(service: KanbanService, journal: KanbanAutomationJournal, options: PersonalKanbanAutomationOptions) {
    return async (board: string, itemId: string): Promise<KanbanPlanningSession | undefined> => {
        const {item} = await service.item(board,itemId);
        const job = await currentAnalysis<IndependentCallInput>(journal,board,itemId);
        if (!job) return;
        const admission = await options.calls.inspectTaskCallSubmission(job.input);
        if (!admission?.executionSessionId) return;
        const sessionId = admission.executionSessionId;
        const resourceId = await options.executionResource?.(sessionId,'main');
        const state = job.status.state === 'clarification' ? 'waiting-input' : job.status.state === 'ready' ? 'completed'
            : job.status.state === 'failed' ? 'failed' : job.status.state === 'analyzing' ? 'running' : 'unknown';
        const operation=item.planning?.coordination?await currentCoordination(journal,board,itemId):undefined;
        const result=operation?.result as {summary?:string;suggestions?:Array<{itemId:string;action:string;reason:string}>}|undefined;
        return {...(operation?{coordination:{id:operation.id,state:operation.state,code:operation.code,...result}}:{}),itemId,analysisId:job.id,sessionId,resourceId,title:item.title,state,stale:false,recent:false};
    };
}

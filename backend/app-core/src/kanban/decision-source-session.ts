import type {KanbanDecisionSourceSession} from '@nestos/kanban/contracts';
import {safeCode} from '@nestos/kanban/integration';
import type {DecisionConversationOptions} from './decision-conversation-ports';
import {requireValue} from './validation';

interface SourceContext {
    source: KanbanDecisionSourceSession;
    title: string;
    excerpts: Array<{role:string;text:string}>;
}

/** Freeze the authorized excerpt once for the creation operation. */
export async function decisionSourceContext(options: DecisionConversationOptions, boardId: string, operationId: string,
    projectId: string, source?: KanbanDecisionSourceSession): Promise<SourceContext | undefined> {
    if (!source) return;
    const started = Date.now(), stage = 'decision.source.read';
    try {
        requireValue(source.projectId === projectId, 'DECISION_SOURCE_PROJECT_MISMATCH');
        const key = 'decision-source-context:' + operationId;
        const prior = await options.journal.get<SourceContext>(key);
        if (prior) return prior;
        const port = await options.remote.projectConversation(source.projectId, source.profileId, source.sessionId, undefined, true);
        try {
            const history = await port.read({includeUsage:false});
            requireValue(history.sessionId === source.sessionId && !history.disconnected, 'DECISION_SOURCE_SESSION_UNAVAILABLE');
            const excerpts = history.messages.filter(message => message.role === 'user' || message.role === 'assistant')
                .slice(-8).map(({role,text}) => ({role,text:text.slice(-1200)}));
            const result = await options.journal.update<SourceContext>(key, old => old ?? {source,title:history.title.slice(0,300),excerpts});
            options.log({operationId,boardId,stage,result:'success',durationMs:Date.now()-started});
            return result;
        } finally {await port.close();}
    } catch (error) {
        options.log({operationId,boardId,stage,result:'failure',code:safeCode(error,'DECISION_SOURCE_SESSION_UNAVAILABLE'),durationMs:Date.now()-started});
        throw error;
    }
}

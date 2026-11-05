import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {IndependentCallService} from '@nestos/llm-session';
import type {KanbanBoard, KanbanItem, KanbanWorkflowState, KanbanSessionAssociation, KanbanSessionExecution} from '@nestos/kanban/contracts';
import type {KanbanSessionSource} from '@nestos/kanban/activity';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {collaborationRelations, safeCode} from '@nestos/kanban/integration';
import {relatedExecutionReader, type SessionExecutionOptions} from './related-session-executions';
import {requireValue} from './validation';

interface Options extends SessionExecutionOptions {
    journal: KanbanAutomationJournal;
    calls: Pick<IndependentCallService, 'inspectTaskCallSubmission'>;
    related?(boardId: string, itemId: string): Promise<KanbanSessionAssociation[]>;
}
const log = createModuleLogger('KanbanSessions');

export function relatedKanbanSessions(options: Options): NonNullable<KanbanSessionSource['related']> {
    return async (board, item, workflow) => {
        const started = Date.now(), operationId = randomUUID();
        try {
            const rows = await collect(options, board, item, workflow);
            log.info('Session relations', {operation: 'kanban.sessions', operationId, stage: 'project', result: 'success', count: rows.length, durationMs: Date.now() - started});
            return rows;
        } catch (error) {
            log.warn('Session relations', {operation: 'kanban.sessions', operationId, stage: 'project', result: 'failure', code: safeCode(error, 'SESSION_RELATIONS_FAILED'), durationMs: Date.now() - started});
            throw error;
        }
    };
}
async function collect(options: Options, board: KanbanBoard, item: KanbanItem, workflow: KanbanWorkflowState): Promise<KanbanSessionAssociation[]> {
    const read = relatedExecutionReader(options), rows: KanbanSessionAssociation[] = [], pending: Array<() => Promise<void>> = [];
    const append = executionAppender(read, rows);
    for (const ref of item.externalRefs ?? []) {
        const dispatch = workflow.dispatches[ref.revision ?? ''];
        if (ref.system === 'nestos-execution-session' && dispatch?.itemId === item.id)
            pending.push(() => append(ref.id, {id: dispatch.id, purpose: 'execution'}));
        if (ref.system === 'nestos-fix-session') {
            if (ref.revision) pending.push(() => append(ref.id, {id: ref.revision!, purpose: 'fix'}));
            else rows.push({sessionId: ref.id, purpose: 'fix'});
        }
    }
    const relations=await collaborationRelations<IndependentCallInput>(options.journal,board.id,item.id);
    for (const job of relations.planning) {
        requireValue(job.request.request.expectedSessionId === job.id, 'SESSION_RELATION_SCOPE_MISMATCH');
        pending.push(async () => {
            const admission = await options.calls.inspectTaskCallSubmission(job.request);
            if (admission?.executionSessionId) await append(admission.executionSessionId, {id: job.id, purpose: 'planning'});
        });
    }
    for (const reply of relations.replies)pending.push(()=>append(reply.executionId,{id:reply.operationId,purpose:'execution'}));
    for (const row of await options.related?.(board.id, item.id) ?? []) {
        if (row.execution) pending.push(() => append(row.sessionId, row.execution!));
        else rows.push(row);
    }
    let next = 0;
    const results = await Promise.allSettled(Array.from({length: Math.min(pending.length, 8)}, async () => {while (next < pending.length) await pending[next++]();}));
    const failure = results.find(row => row.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
    return rows;
}
function executionAppender(read: ReturnType<typeof relatedExecutionReader>, rows: KanbanSessionAssociation[]) {
    return async (sessionId: string, execution: KanbanSessionExecution) => {
        const started = Date.now();
        try {rows.push({sessionId, purpose: execution.purpose, execution: await read(sessionId, execution)});}
        catch (error) {
            const code = safeCode(error, 'SESSION_RELATION_READ_FAILED');
            log.warn('Session execution projection', {operation: 'kanban.sessions', operationId: execution.id, stage: 'execution.read', result: 'failure', code, durationMs: Date.now() - started});
            rows.push({sessionId, purpose: execution.purpose, execution: {...execution, state: 'unknown', code}});
        }
    };
}

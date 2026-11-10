import {createModuleLogger} from '@nestos/common';
import {journalCommand, type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {KanbanService, KanbanRecordInput} from '@nestos/kanban/contracts';
import {channelDigest} from '../run/channel-protocol';
import {failure} from '../run/prompt-bundle';
import {parseSessionLearnings} from './session-learnings-input';
import type {ChannelMessage} from '../run/channel-results';

interface Input {
    boardId: string; sessionId?: string; messageId: string; payload: unknown;
    service: KanbanService; journal: KanbanAutomationJournal; publications?: ChannelMessage[];
}
const log = createModuleLogger('KanbanLearnings');

/** The host supplies the execution identity; report text cannot establish ownership. */
export async function registerSessionLearnings(input: Input): Promise<void> {
    if (!input.sessionId) return;
    const operationId = 'learning-review-' + channelDigest([input.boardId, input.sessionId, input.messageId]), started = Date.now();
    let rows: ReturnType<typeof parseSessionLearnings>;
    try {rows = parseSessionLearnings(input.payload);}
    catch (error) {
        const code = (error as {code: string}).code;
        log.warn('Session learning', {operation: 'kanban.learning', operationId, stage: 'validate', result: 'failure', code, durationMs: Date.now() - started});
        await input.journal.update(operationId + ':status', () => ({state: 'pending', stage: 'validate', code}));
        throw error;
    }
    for (const row of rows) await registerOne(input, row);
}

type Learning = ReturnType<typeof parseSessionLearnings>[number];
async function registerOne(input: Input, row: Learning): Promise<void> {
    const operationId = 'learning-' + channelDigest([input.boardId, input.sessionId, row.itemId, row.id]);
    const started = Date.now(); let stage = 'association';
    try {
        const {item} = await input.service.item(input.boardId, row.itemId);
        const workflow = await input.service.workflow(input.boardId);
        const linked = item.externalRefs?.some(ref => ref.system === 'nestos-execution-session' && ref.id === input.sessionId
            && workflow.dispatches[ref.revision ?? '']?.itemId === item.id);
        if (!linked) throw failure('LEARNING_TASK_NOT_ASSOCIATED');
        stage = 'evidence'; const record = learningRecord(input, row, operationId);
        stage = 'persist'; await persist(input, operationId, record);
        log.info('Session learning', {operation: 'kanban.learning', operationId, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const raw = (error as {code?: unknown})?.code;
        const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'LEARNING_STORAGE_FAILED';
        log.warn('Session learning', {operation: 'kanban.learning', operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
        await input.journal.update(operationId + ':status', () => ({state: 'pending', stage, code}));
        throw failure(code);
    }
}

function learningRecord(input: Input, row: Learning, id: string): KanbanRecordInput {
    const evidence = row.evidence.map(messageId => {
        const publication = input.publications?.find(entry => entry.id === messageId);
        if (!publication) throw failure('LEARNING_EVIDENCE_MISSING');
        return {sessionId: input.sessionId!, messageId, revision: channelDigest(publication.message), role: 'assistant' as const};
    });
    return {id, kind: 'log', title: row.event, itemIds: [row.itemId],
        content: [row.event, row.handling, row.result, row.conditions].join('\n\n'), rationale: row.reason,
        sources: [{sessionId: input.sessionId!, messageId: input.messageId, revision: channelDigest(input.payload), role: 'assistant'}, ...evidence]};
}

async function persist(input: Input, operationId: string, record: KanbanRecordInput): Promise<void> {
    const digest = channelDigest({itemIds: record.itemIds, title: record.title, content: record.content, rationale: record.rationale});
    await input.journal.update<{digest: string}>(operationId + ':input', old => {
        if (old && old.digest !== digest) throw failure('LEARNING_IDENTITY_CONFLICT');
        return old ?? {digest};
    });
    await journalCommand(input.journal, input.service, input.boardId, operationId, {type: 'append-record', record});
    await input.journal.update(operationId + ':status', () => ({state: 'registered'}));
}

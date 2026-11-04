import {createModuleLogger, randomUUID, sha256HexSync} from '@nestos/common';
import type {KanbanClient, KanbanDeletionPreview} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {safeCode, analysisHistory} from './automation-analysis';
import {requireValue} from './validation';

export interface Options {service: KanbanClient; journal: KanbanAutomationJournal}
type Blocker = KanbanDeletionPreview['blockers'][number];
const log = createModuleLogger('kanban-board-deletion-inspection');
const settled = new Set(['idle', 'completed', 'failed', 'cancelled']);

export async function boardDeletionBlockers({service, journal}: Options, boardId: string, items?: Array<{id: string; title: string}>): Promise<Blocker[]> {
    const board = await service.read(boardId), workflow = await service.workflow(boardId), rows: Blocker[] = [];
    for (const item of board.items) if (item.owner || item.transfer || item.status === 'claimed') rows.push({code: 'BOARD_EXECUTION_ACTIVE', itemId: item.id});
    for (const dispatch of Object.values(workflow.dispatches)) if (['prepared', 'running', 'unknown', 'succeeded'].includes(dispatch.outcome)) rows.push({code: 'BOARD_EXECUTION_UNSETTLED', itemId: dispatch.itemId});
    const reviews = await journal.findForBoard<{boardId: string; itemId: string; phase: string}>('review-operation:', boardId, job => job.boardId === boardId && job.phase !== 'settled');
    rows.push(...reviews.map(({value}) => ({code: 'BOARD_MAINTENANCE_ACTIVE', itemId: value.itemId})));
    const runs = await journal.findForBoard<Array<{sourceBoardId: string; boardId: string; state: string}>>('record-runs:', boardId, runs => runs.some(run => (run.sourceBoardId === boardId || run.boardId === boardId) && !['completed', 'failed'].includes(run.state)));
    if (runs.length) rows.push({code: 'BOARD_DECISION_UNSETTLED'});
    rows.push(...await pendingCollaboration(journal, boardId));
    rows.push(...(await inspectItems(items ?? await deletionItems(service, boardId), item => itemBlockers(service, journal, boardId, item.id))).flat());
    return [...new Map(rows.map(row => [JSON.stringify([row.code, row.itemId, row.sessionId]), row])).values()];
}

export async function deletionPreview(options: Options, boardId: string): Promise<KanbanDeletionPreview> {
    const {service} = options;
    const board = await service.read(boardId), actor = await service.currentPrincipal();
    requireValue(board.deletedAt === undefined, 'BOARD_DELETED');
    requireValue(actor.kind === 'human' && board.members?.some(row => row.kind === actor.kind && row.id === actor.id && row.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
    const items = await deletionItems(service, boardId), itemTitles = Object.fromEntries(items.map(item => [item.id, item.title]));
    const operationId = randomUUID();
    const blockers = await inspectionStage(operationId, 'local-and-sessions', () => boardDeletionBlockers(options, boardId, items));
    const resources = (await inspectionStage(operationId, 'work-resources', () => inspectItems(items, async item =>
        (await service.workResources?.(boardId, item.id) ?? []).map(resource => ({itemId: item.id, resource}))))).flat();
    for (const {itemId, resource} of resources) if (resource.state === 'in-use' && !blockers.some(row => row.code === 'BOARD_EXECUTION_ACTIVE' && row.itemId === itemId)) blockers.push({code: 'BOARD_EXECUTION_ACTIVE', itemId});
    const result = {boardId, title: board.title, revision: board.revision, itemTitles, blockers, pendingItems: board.items.filter(item => !['completed', 'cancelled'].includes(item.status)).length, resources};
    requireValue((await service.read(boardId)).revision === board.revision, 'REVISION_CONFLICT');
    return {...result, version: sha256HexSync(JSON.stringify(result))};
}

async function deletionItems(service: KanbanClient, board: string): Promise<Array<{id: string; title: string}>> {
    const items: Array<{id: string; title: string}> = []; let cursor: string | undefined;
    do {const page = await service.query(board, {view: 'all', limit: 200, ...(cursor ? {cursor} : {})});
        items.push(...page.items.map(({id, title}) => ({id, title}))); cursor = page.nextCursor;
        requireValue(items.length <= 10000, 'BOARD_DELETE_RESOURCE_LIMIT');
    } while (cursor);
    return items;
}
async function itemBlockers(service: KanbanClient, journal: KanbanAutomationJournal, board: string, item: string): Promise<Blocker[]> {
    const rows: Blocker[] = [];
    if ((await analysisHistory(journal, board, item)).some(job => job.phase !== 'settled')) rows.push({code: 'BOARD_ANALYSIS_UNSETTLED', itemId: item});
    if (!service.executionSession) return rows;
    const detail = await service.executionSession(board, item, {includeRelated: true});
    if (detail.sessionsCode) rows.push({code: detail.sessionsCode, itemId: item});
    for (const session of detail.sessions ?? []) if (session.stale || !settled.has(session.state) || session.executions.some(run => run.state && !settled.has(run.state))) rows.push({code: 'BOARD_SESSION_UNSETTLED', itemId: item, sessionId: session.sessionId});
    return rows;
}

async function pendingCollaboration(journal: KanbanAutomationJournal, boardId: string): Promise<Blocker[]> {
    const [fixes, replies] = await Promise.all([
        journal.findForBoard<{itemId: string; accepted?: boolean}>('fix:', boardId, fix => !fix.accepted),
        journal.findForBoard<{request: {itemId: string}}>('task-reply:', boardId, () => true),
    ]);
    const delivered = await journal.getMany(replies.map(row => 'task-reply-delivered:' + row.key.slice('task-reply:'.length)));
    return [...fixes.map(({value}) => ({code: 'BOARD_FIX_UNSETTLED', itemId: value.itemId})),
        ...replies.filter((_, index) => !delivered[index]).map(({value}) => ({code: 'BOARD_REPLY_UNSETTLED', itemId: value.request.itemId}))];
}
/** Bound remote pressure, preserve order, and drain workers before propagating failures. */
async function inspectItems<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = []; let next = 0, stopped = false;
    const workers = Array.from({length: Math.min(4, items.length)}, async () => {
        while (!stopped && next < items.length) {
            const index = next++;
            try {results[index] = await run(items[index]);} catch (error) {stopped = true; throw error;}
        }
    });
    const settled = await Promise.allSettled(workers), failed = settled.find(row => row.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    return results;
}
async function inspectionStage<T>(operationId: string, stage: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {const result = await run(); log.info('board.deletion.inspect', {operation: 'kanban.board.delete', operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;}
    catch (error) {log.warn('board.deletion.inspect', {operation: 'kanban.board.delete', operationId, stage, result: 'failure', code: safeCode(error, 'BOARD_INSPECTION_FAILED'), durationMs: Date.now() - started}); throw error;}
}

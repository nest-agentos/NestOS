import {sha256HexSync} from '@nestos/common';
import type {KanbanClient, KanbanDeletionPreview} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {analysisHistory} from './automation-analysis';
import {requireValue} from './validation';

export interface Options {service: KanbanClient; journal: KanbanAutomationJournal}
type Blocker = KanbanDeletionPreview['blockers'][number];
const settled = new Set(['idle', 'completed', 'failed', 'cancelled']);

export async function boardDeletionBlockers({service, journal}: Options, boardId: string): Promise<Blocker[]> {
    const board = await service.read(boardId), workflow = await service.workflow(boardId), rows: Blocker[] = [];
    for (const item of board.items) if (item.owner || item.transfer || item.status === 'claimed') rows.push({code: 'BOARD_EXECUTION_ACTIVE', itemId: item.id});
    for (const dispatch of Object.values(workflow.dispatches)) if (['prepared', 'running', 'unknown', 'succeeded'].includes(dispatch.outcome)) rows.push({code: 'BOARD_EXECUTION_UNSETTLED', itemId: dispatch.itemId});
    const reviews = await journal.find<{boardId: string; itemId: string; phase: string}>('review-operation:', job => job.boardId === boardId && job.phase !== 'settled');
    rows.push(...reviews.map(({value}) => ({code: 'BOARD_MAINTENANCE_ACTIVE', itemId: value.itemId})));
    const runs = await journal.find<Array<{sourceBoardId: string; boardId: string; state: string}>>('record-runs:', runs => runs.some(run => (run.sourceBoardId === boardId || run.boardId === boardId) && !['completed', 'failed'].includes(run.state)));
    if (runs.length) rows.push({code: 'BOARD_DECISION_UNSETTLED'});
    rows.push(...await pendingCollaboration(journal, boardId));
    for (const itemId of await itemIds(service, boardId)) rows.push(...await itemBlockers(service, journal, boardId, itemId));
    return rows;
}

export async function deletionPreview(options: Options, boardId: string): Promise<KanbanDeletionPreview> {
    const {service} = options;
    const board = await service.read(boardId), actor = await service.currentPrincipal();
    requireValue(board.deletedAt === undefined, 'BOARD_DELETED');
    requireValue(actor.kind === 'human' && board.members?.some(row => row.kind === actor.kind && row.id === actor.id && row.roles?.includes('coordinator')), 'COORDINATOR_REQUIRED');
    const resources: KanbanDeletionPreview['resources'] = [];
    for (const itemId of await itemIds(service, boardId)) for (const resource of await service.workResources?.(boardId, itemId) ?? []) resources.push({itemId, resource});
    const blockers = await boardDeletionBlockers(options, boardId);
    for (const {itemId, resource} of resources) if (resource.state === 'in-use') blockers.push({code: 'BOARD_EXECUTION_ACTIVE', itemId});
    const result = {boardId, title: board.title, revision: board.revision, blockers, pendingItems: board.items.filter(item => !['completed', 'cancelled'].includes(item.status)).length, resources};
    requireValue((await service.read(boardId)).revision === board.revision, 'REVISION_CONFLICT');
    return {...result, version: sha256HexSync(JSON.stringify(result))};
}

async function itemIds(service: KanbanClient, board: string): Promise<string[]> {
    const ids: string[] = []; let cursor: string | undefined;
    do {const page = await service.query(board, {view: 'all', limit: 200, ...(cursor ? {cursor} : {})});
    ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor;
    requireValue(ids.length <= 10000, 'BOARD_DELETE_RESOURCE_LIMIT');
    } while (cursor);
    return ids;
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
    const rows: Blocker[] = [];
    for (const id of await journal.get<string[]>('fix-index') ?? []) {
        const fix = await journal.get<{boardId: string; itemId: string; accepted?: boolean}>('fix:' + id);
        if (fix?.boardId === boardId && !fix.accepted) rows.push({code: 'BOARD_FIX_UNSETTLED', itemId: fix.itemId});
    }
    for (const id of await journal.get<string[]>('task-reply-index') ?? []) {
        const reply = await journal.get<{boardId: string; request: {itemId: string}}>('task-reply:' + id);
        if (reply?.boardId === boardId && !await journal.get('task-reply-delivered:' + id)) rows.push({code: 'BOARD_REPLY_UNSETTLED', itemId: reply.request.itemId});
    }
    return rows;
}

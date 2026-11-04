import {createModuleLogger, randomUUID, sha256HexSync} from '@nestos/common';
import type {KanbanClient, KanbanDeletionPreview, KanbanDeletionRequest} from '@nestos/kanban/contracts';
import {KanbanError} from '@nestos/kanban';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';
import {boardDeletionBlockers, deletionPreview, type Options} from './board-deletion-inspection';
const log = createModuleLogger('kanban-board-deletion');

/** A retained tombstone preserves audit and resource provenance without owning Sessions. */
export function createBoardDeletion(options: Options) {
    return {
        previewDeletion: (id: string) => traced(id, randomUUID(), 'preview', () => deletionPreview(options, id)),
        assertSettled: async (id: string) => {const rows = await boardDeletionBlockers(options, id); requireValue(!rows.length, rows[0]?.code ?? 'BOARD_EXECUTION_UNSETTLED');},
        deleteBoard: (id: string, request: KanbanDeletionRequest) => traced(id, request.operationId, 'delete', () => removeBoard(options, id, request)),
    };
}
interface Receipt {request: KanbanDeletionRequest; preview: KanbanDeletionPreview; phase: string}
async function removeBoard(options: Options, id: string, request: KanbanDeletionRequest): Promise<void> {
    const {service, journal} = options;
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && typeof request.cleanup === 'boolean' && /^[a-f0-9]{64}$/.test(request.version), 'INVALID_OPERATION_ID');
    const key = 'board-deletion:' + id, receipt = await journal.get<Receipt>(key);
    if (receipt?.request.operationId === request.operationId) {
        requireValue(JSON.stringify(receipt.request) === JSON.stringify(request), 'IDEMPOTENCY_CONFLICT');
        if ((await service.read(id)).deletedAt !== undefined) return;
    }
    const current = await deletionPreview(options, id);
    requireValue(current.revision === request.expectedRevision && current.version === request.version, 'BOARD_DELETE_PREVIEW_CHANGED');
    requireValue(!current.blockers.length, current.blockers[0]?.code ?? 'BOARD_EXECUTION_UNSETTLED');
    await journal.update(key, () => ({request, preview: current, phase: 'prepared'}));
    if (request.cleanup) await cleanupResources(options, id, request, current);
    const board = await service.read(id);
    requireValue(board.revision === request.expectedRevision, 'BOARD_DELETE_PREVIEW_CHANGED');
    await service.execute(id, {operationId: request.operationId, expectedRevision: board.revision, command: {type: 'delete-board'}});
    await journal.update<Receipt>(key, old => ({...old!, phase: 'deleted'}));
}
async function cleanupResources({service}: Options, id: string, request: KanbanDeletionRequest, preview: KanbanDeletionPreview): Promise<void> {
    const groups = new Map<string, KanbanDeletionPreview['resources']>();
    for (const row of preview.resources) {
        const key = JSON.stringify([row.resource.kind, row.resource.id, row.resource.location]);
        const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const group of groups.values()) if (group.every(row => row.resource.canCleanup)) {
        const {itemId, resource} = group[0];
        requireValue(service.cleanupWorkResource, 'WORK_RESOURCE_CLEANUP_UNAVAILABLE');
        await traced(id, request.operationId, 'cleanup', () => service.cleanupWorkResource!(id, {itemId, resourceId: resource.id, version: resource.version,
            operationId: sha256HexSync(JSON.stringify([request.operationId, resource.id]))}));
    }
}
async function traced<T>(boardId: string, operationId: string, stage: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now(); operationId = /^[\w-]{1,128}$/.test(operationId) ? operationId : randomUUID();
    try {const result = await run(); log.info('board.deletion', {operation: 'kanban.board.delete', boardId, operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;}
    catch (error) {log.warn('board.deletion', {operation: 'kanban.board.delete', boardId, operationId, stage, result: 'failure', code: safeCode(error, 'BOARD_DELETE_FAILED'), durationMs: Date.now() - started}); throw error;}
}

/** Concurrent admissions share an exclusive deletion barrier; queries never wait for scans. */
export function withBoardDeletion<T extends KanbanClient & {quiesce?(): Promise<void>; dispose?(): Promise<void>}>(service: T, deletion: ReturnType<typeof createBoardDeletion>): T & Pick<typeof deletion, 'previewDeletion' | 'deleteBoard'> {
    let barrier: Promise<unknown> = Promise.resolve(), stopping = false;
    const pending = new Set<Promise<unknown>>();
    let quiescing: Promise<void> | undefined, disposing: Promise<void> | undefined;
    const quiesce = () => {
        stopping = true;
        if (!quiescing) {
            // Broadcast immediately, including while an exclusive operation is finishing.
            const acknowledgements = Promise.allSettled([service.quiesce?.() ?? Promise.resolve(), ...pending]);
            quiescing = (async () => {
                await barrier;
                const [ack] = await acknowledgements;
                if (ack.status === 'rejected') throw ack.reason;
            })();
        }
        return quiescing;
    };
    const close = (method: 'quiesce' | 'dispose') => method === 'quiesce' ? quiesce()
        : disposing ??= quiesce().then(() => service.dispose?.());
    const admit = <R>(run: () => Promise<R>): Promise<R> => {
        if (stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const next = barrier.then(run); pending.add(next); void next.finally(() => pending.delete(next)).catch(() => {}); return next;
    };
    const exclusive = <R>(run: () => Promise<R>): Promise<R> => {
        if (stopping) return Promise.reject(new KanbanError('SERVICE_STOPPING'));
        const admitted = [...pending], next = barrier.then(async () => {await Promise.allSettled(admitted); return run();});
        barrier = next.catch(() => {}); return next;
    };
    const active = async <R>(id: string, run: () => Promise<R>) => {requireValue((await service.read(id)).deletedAt === undefined, 'BOARD_DELETED'); return run();};
    return {...service, ...(service.quiesce ? {quiesce: () => close('quiesce')} : {}), ...(service.dispose ? {dispose: () => close('dispose')} : {}), previewDeletion: deletion.previewDeletion, deleteBoard: (id, request) => exclusive(() => deletion.deleteBoard(id, request)),
        execute: (id, request) => admit(() => active(id, () => {if (request.command.type === 'delete-board') throw new KanbanError('BOARD_DELETE_CONFIRMATION_REQUIRED'); return service.execute(id, request);})),
        scan: () => admit(() => service.scan()),
        ...(service.fixTask ? {fixTask: (id: string, request: Parameters<NonNullable<T['fixTask']>>[1]) => admit(() => active(id, () => service.fixTask!(id, request)))} : {}),
        ...(service.replyTask ? {replyTask: (id: string, request: Parameters<NonNullable<T['replyTask']>>[1]) => admit(() => active(id, () => service.replyTask!(id, request)))} : {}),
        ...(service.runRecord ? {runRecord: (id: string, request: Parameters<NonNullable<T['runRecord']>>[1]) => admit(() => active(id, () => service.runRecord!(id, request)))} : {}),
        ...(service.runItemOperation ? {runItemOperation: (id: string, request: Parameters<NonNullable<T['runItemOperation']>>[1]) => admit(() => active(id, () => service.runItemOperation!(id, request)))} : {}),
        ...(service.bindItemOperation ? {bindItemOperation: (id: string, request: Parameters<NonNullable<T['bindItemOperation']>>[1]) => admit(() => active(id, () => service.bindItemOperation!(id, request)))} : {}),
        ...(service.cleanupWorkResource ? {cleanupWorkResource: (id: string, request: Parameters<NonNullable<T['cleanupWorkResource']>>[1]) => admit(() => service.cleanupWorkResource!(id, request))} : {}),
    };
}

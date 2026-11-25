import type {KanbanDispatch, KanbanItem} from '@nestos/kanban/contracts';

/** A formal reference must match the accepted dispatch for this exact item. */
export function adoptionExecution(item: KanbanItem, dispatches: Record<string, KanbanDispatch>) {
    const prefix = 'kanban:dispatch:';
    if (item.status !== 'completed' || !item.resultRef?.startsWith(prefix)) return undefined;
    const dispatch = dispatches[item.resultRef.slice(prefix.length)];
    if (!dispatch || dispatch.itemId !== item.id || dispatch.outcome !== 'accepted' || !dispatch.executionSessionId
        || item.acceptanceResult?.outcome === 'waived'
        || item.acceptanceResult && item.acceptanceResult.dispatchId !== dispatch.id) return undefined;
    return {dispatchId: dispatch.id, sessionId: dispatch.executionSessionId, outputs: structuredClone(dispatch.outputs ?? [])};
}

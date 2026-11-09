import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {automaticDelivery} from '../src/kanban/automatic-delivery';

it.each([
    {state: 'running', runId: 'original-build', recovered: true},
    {state: 'unknown', runId: 'original-build', recovered: false},
    {state: 'running', runId: 'different-build', recovered: false},
])('clears stale preparation failure only for the same confirmed running operation: $state $runId', async row => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const journal = new KanbanAutomationJournal(await manager.openFileSystem('/')); await journal.open();
        const storageKey = 'automatic-delivery:' + JSON.stringify(['board', 'task']);
        await journal.update(storageKey, () => ({id: 'auto', boardId: 'board', itemId: 'task', executionId: 'dispatch', step: 0, steps: ['build', 'cleanup'], code: 'EIO', requests: {build: {operationId: 'original-build'}}}));
        const item = {id: 'task', status: 'review', planning: {kind: 'task'}}, board = {id: 'board', automation: {enabled: true}, items: [item]};
        const run = vi.fn(), cleanup = vi.fn(), options = {journal, run, cleanup, active: () => true, automatic: async () => true,
            service: {catalog: async () => [{id: 'board'}], read: async () => board, workflow: async () => ({dispatches: {dispatch: {id: 'dispatch', itemId: 'task', attempt: 1, outcome: 'succeeded'}}})},
            view: async () => ({revision: 'current', operations: [{id: 'build', enabled: false, state: row.state, runId: row.runId}]})};
        for (let attempt = 0; attempt < 2; attempt++) await automaticDelivery(options as never).scan();
        const state = await journal.get<{step: number; code?: string}>(storageKey);
        expect(state?.step).toBe(0); expect(state?.code).toBe(row.recovered ? undefined : 'EIO');
        expect(run).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled();
    } finally {await manager.dispose();}
});

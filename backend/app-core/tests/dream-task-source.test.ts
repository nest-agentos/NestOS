import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import {scanSources} from '@nestos/dream';
import {createNestOSKanban} from '../src/kanban';
import {UserEventService} from '../src/events/service';
import {taskSourcePort} from '../src/dream/task-source';

it('point-reads the selected project task without exposing its body', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let events: UserEventService | undefined;
    try {
        const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
        events = await UserEventService.open(fs);
        const service = createNestOSKanban({store, authorize: async () => {}, log: vi.fn(), actor: {kind: 'human', id: 'admin'},
            notifications: {sourceId: 'test', journal: events.journal}});
        const board = await service.create({id: 'board', title: 'Board', scope: {kind: 'project', projectId: 'project'},
            members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator']}], policy: {requireEstimate: false}});
        await service.execute('board', {operationId: 'parent', expectedRevision: board.revision, command: {type: 'create-item', item: {
            id: 'parent', taskType: 'coordination', title: 'Parent', responsibility: 'Manage', acceptance: 'Complete'}}});
        await service.execute('board', {operationId: 'create', expectedRevision: (await service.read('board')).revision, command: {type: 'create-item', item: {
            id: 'task', taskType: 'execution', title: 'Selected task', responsibility: 'Private responsibility', acceptance: 'Private acceptance',
            externalRefs: [{system: 'nestos-remote-project', id: 'project'}]}, planning: {parentId: 'parent', kind: 'task', priority: 2, dependencies: [], references: []}}});
        const source = {id: 'source', projectId: 'project', connectionId: 'connection', boardId: 'board', itemId: 'task'};
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const item = vi.spyOn(service, 'item'), port = taskSourcePort(source, service, async () => authority);
        const input = {id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null};
        const [first] = await scanSources([input], 1, port);
        expect(first.status).toBe('ok'); if (first.status !== 'ok') throw new Error('unexpected result');
        expect(first.items[0]).toContain('Selected task'); expect(first.items[0]).not.toContain('Private responsibility');
        expect(item).toHaveBeenCalledWith('board', 'task');
        expect((await scanSources([{...input, cursor: first.evidence.endCursor}], 1, port))[0]).toMatchObject({status: 'ok', items: []});
        const original = await service.item('board', 'task');
        item.mockResolvedValueOnce({...original, item: {...original.item, revision: original.item.revision + 1, title: 'Updated task'}});
        expect((await scanSources([{...input, cursor: first.evidence.endCursor}], 1, port))[0])
            .toMatchObject({status: 'ok', items: [expect.stringContaining('Updated task')]});
        expect((await scanSources([input], 1, taskSourcePort(source, service, async () => {throw new Error('revoked');})))[0])
            .toMatchObject({status: 'failed', code: 'AUTHORIZATION_FAILED'});
        expect((await scanSources([{...input, projectId: 'other'}], 1, taskSourcePort({...source, projectId: 'other'}, service, async () => authority)))[0])
            .toMatchObject({status: 'failed', code: 'READ_FAILED'});
    } finally {events?.journal.close(); await manager.dispose();}
});

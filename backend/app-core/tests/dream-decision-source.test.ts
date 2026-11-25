import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import {scanSources} from '@nestos/dream';
import {createNestOSKanban} from '../src/kanban';
import {UserEventService} from '../src/events/service';
import {decisionSourcePort} from '../src/dream/decision-source';

it('point-reads one authorized project decision and advances only on change', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let events: UserEventService | undefined;
    try {
        const fs = await manager.openFileSystem('/'), store = await SeqKanbanStore.open(fs);
        events = await UserEventService.open(fs);
        const service = createNestOSKanban({store, authorize: async () => {}, log: vi.fn(), actor: {kind: 'human', id: 'admin'},
            notifications: {sourceId: 'test', journal: events.journal}});
        const board = await service.create({id: 'board', title: 'Board', scope: {kind: 'project', projectId: 'project'},
            members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator', 'reviewer']}], policy: {requireEstimate: false}});
        await service.execute('board', {operationId: 'append', expectedRevision: board.revision, command: {type: 'append-record', record: {
            id: 'decision', kind: 'decision', title: 'Selected decision', content: 'private body', rationale: 'private rationale', itemIds: [], sources: [],
            externalRefs: [{system: 'nestos-remote-project', id: 'project'}]}}});
        await service.execute('board', {operationId: 'review', expectedRevision: (await service.read('board')).revision,
            command: {type: 'review-record', recordId: 'decision', accept: true}});
        const source = {id: 'source', projectId: 'project', connectionId: 'connection', boardId: 'board', recordId: 'decision'};
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'project'};
        const record = vi.spyOn(service, 'record');
        const port = decisionSourcePort(source, service, async () => authority);
        const input = {id: source.id, projectId: source.projectId, connectionId: source.connectionId, cursor: null};
        const [first] = await scanSources([input], 1, port);
        expect(first.status).toBe('ok');
        if (first.status !== 'ok') throw new Error('unexpected result');
        expect(first.items[0]).toContain('Selected decision'); expect(first.items[0]).not.toContain('private body');
        expect(record).toHaveBeenCalledWith('board', 'decision');
        expect((await scanSources([{...input, cursor: first.evidence.endCursor}], 1, port))[0]).toMatchObject({status: 'ok', items: []});
        const original = await service.record('board', 'decision');
        record.mockResolvedValueOnce({...original, revision: original.revision + 1, title: 'Updated decision'});
        expect((await scanSources([{...input, cursor: first.evidence.endCursor}], 1, port))[0]).toMatchObject({status: 'ok', items: [expect.stringContaining('Updated decision')]});
        const denied = decisionSourcePort(source, service, async () => {throw new Error('revoked');});
        expect((await scanSources([input], 1, denied))[0]).toMatchObject({status: 'failed', code: 'AUTHORIZATION_FAILED'});
        const outside = {...source, projectId: 'other'};
        expect((await scanSources([{...input, projectId: 'other'}], 1, decisionSourcePort(outside, service, async () => authority)))[0])
            .toMatchObject({status: 'failed', code: 'READ_FAILED'});
    } finally {events?.journal.close(); await manager.dispose();}
});

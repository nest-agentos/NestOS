import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {createNestOSKanban} from '../src/kanban';
import {UserEventService} from '../src/events/service';
import {DreamConfigStore} from '../src/dream/config-store';
import {DreamEvidenceStore} from '../src/dream/evidence-store';
import {adoptDreamSuggestion} from '../src/dream/adopt-suggestion';

it('creates one manually controlled task after explicit adoption, even when the first reply is lost', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let journal: KanbanAutomationJournal | undefined, events: UserEventService | undefined;
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs), evidence = new DreamEvidenceStore(fs);
        const file = {id: 'source', projectId: 'source-project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: [file]}, {owner: async () => {}, source: async () => {}});
        const authority = {principalId: 'alice', revision: '1', projectRevision: '1', serverId: 'node', serverProjectId: 'remote'};
        await evidence.settle('owner', 'dream', 'run', [{status: 'ok', items: [], evidence: {sourceId: file.id, projectId: file.projectId,
            connectionId: file.connectionId, authority, startCursor: null, endCursor: 'next', version: 'v1', scanned: 0}}],
        [{id: 'suggestion', sourceId: file.id, kind: 'suggestion', content: 'Suggested action'}], {scanRunId: 'scan', sessionId: 'session', taskId: 'task'});
        const kanbanStore = await SeqKanbanStore.open(fs); events = await UserEventService.open(fs);
        const service = createNestOSKanban({store: kanbanStore, authorize: async () => {}, log: vi.fn(), actor: {kind: 'human', id: 'admin'},
            notifications: {sourceId: 'test', journal: events.journal}});
        await service.create({id: 'board', title: 'Board', scope: {kind: 'project', projectId: 'target'},
            members: [{kind: 'human', id: 'admin', responsibility: 'Manage', roles: ['worker', 'coordinator']}], policy: {requireEstimate: false}});
        await service.execute('board', {operationId: 'create-parent', expectedRevision: (await service.read('board')).revision,
            command: {type: 'create-item', item: {id: 'parent', taskType: 'coordination', title: 'Parent', responsibility: 'Coordinate', acceptance: 'Complete'}}});
        journal = new KanbanAutomationJournal(fs, {directory: '/var/lib/projects/owner/dream/dream/adoption'}); await journal.open();
        let lost = true;
        const kanban = {read: service.read.bind(service), item: service.item.bind(service), execute: async (...args: Parameters<typeof service.execute>) => {
            const response = await service.execute(...args);
            if (lost) {lost = false; throw new Error('lost reply');} return response;
        }};
        const deps = {configs, evidence, journal, kanban, source: {authorize: async () => authority},
            authorizeOwner: async () => {}, authorizeTarget: async () => {}};
        const request = {ownerProjectId: 'owner', dreamId: 'dream', runId: 'run', suggestionId: 'suggestion', operationId: 'adopt',
            boardId: 'board', targetProjectId: 'target', parentItemId: 'parent', title: 'Investigate', responsibility: 'Investigate issue', acceptance: 'Record findings'};
        await expect(adoptDreamSuggestion(request, deps)).rejects.toThrow('DREAM_ADOPTION_FAILED');
        const accepted = await adoptDreamSuggestion(request, deps);
        expect(await adoptDreamSuggestion(request, deps)).toEqual(accepted);
        const items = (await service.read('board')).items;
        expect(items).toHaveLength(2);
        expect(items.find(item => item.id === accepted.itemId)).toMatchObject({id: accepted.itemId, status: 'backlog', launch: {mode: 'manual'}, control: {action: 'pause'}});
        await expect(adoptDreamSuggestion({...request, title: 'Changed'}, deps)).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        await expect(adoptDreamSuggestion({...request, operationId: 'revoked'}, {...deps, source: {authorize: async () => {throw new Error('private');}}}))
            .rejects.toThrow('DREAM_SUGGESTION_UNAVAILABLE');
        expect((await service.read('board')).items).toHaveLength(2);
    } finally {await journal?.drain(); events?.journal.close(); await manager.dispose();}
});

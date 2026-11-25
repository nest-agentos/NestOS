import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {readAdoptionSource} from '../src/dream/adoption-source';
import {adoptionSourcePort, configuredAdoptionSource} from '../src/dream/adoption-source';
import {scanSources} from '@nestos/dream';

it('reads verified journal artifacts once and fails closed when access or execution changes', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let journal: KanbanAutomationJournal | undefined;
    try {
        const fs = await manager.openFileSystem('/');
        journal = new KanbanAutomationJournal(fs); await journal.open();
        const outputs = await journal.artifact('dispatch', {result: 'verified'});
        const execution = {dispatchId: 'dispatch', sessionId: 'session', outputs};
        const current = vi.fn(async () => execution);
        const first = await readAdoptionSource('operation', null, 1, current, journal);
        expect(first.items).toEqual(['{"result":"verified"}']);
        expect((await readAdoptionSource('operation', first.cursor, 1, current, journal)).items).toEqual([]);
        const identity = {id: 'source', projectId: 'project', connectionId: 'connection'};
        const authority = {principalId: 'user', revision: '1', projectRevision: '1', serverId: 'server', serverProjectId: 'project'};
        const port = adoptionSourcePort(identity, 'operation', async () => authority, current, journal);
        const [scan] = await scanSources([{...identity, cursor: null}], 1, port);
        expect(scan).toMatchObject({status: 'ok', items: ['{"result":"verified"}']});
        const [unchanged] = await scanSources([{...identity, cursor: first.cursor}], 1, port);
        expect(unchanged).toMatchObject({status: 'ok', items: []});
        const [denied] = await scanSources([{...identity, cursor: null}], 1,
            adoptionSourcePort(identity, 'operation', async () => {throw new Error('revoked');}, current, journal));
        expect(denied).toMatchObject({status: 'failed', code: 'AUTHORIZATION_FAILED'});
        const config = {name: 'Dream', enabled: true, files: [], adoptions: [{id: 'source', boardId: 'board', itemId: 'item'}]};
        const request = {ownerProjectId: 'owner', dreamId: 'dream', runId: 'run', suggestionId: 'suggestion', operationId: 'operation',
            boardId: 'board', targetProjectId: 'project', parentItemId: 'parent', title: 'Task', responsibility: 'Do', acceptance: 'Done'};
        const selected = configuredAdoptionSource(config, 'owner', 'dream', 'source', request, async () => authority,
            async () => ({itemId: 'item', execution}), journal);
        const [selectedResult] = await scanSources([{id: 'source', projectId: 'project', connectionId: 'kanban-adoption', cursor: null}], 1, selected);
        expect(selectedResult).toMatchObject({status: 'ok', items: ['{"result":"verified"}']});
        expect(() => configuredAdoptionSource(config, 'other', 'dream', 'source', request, async () => authority,
            async () => ({itemId: 'item', execution}), journal!)).toThrow('DREAM_SOURCE_NOT_CONFIGURED');
        const wrongItem = configuredAdoptionSource(config, 'owner', 'dream', 'source', request, async () => authority,
            async () => ({itemId: 'other', execution}), journal);
        const [wrong] = await scanSources([{id: 'source', projectId: 'project', connectionId: 'kanban-adoption', cursor: null}], 1, wrongItem);
        expect(wrong).toMatchObject({status: 'failed', code: 'AUTHORIZATION_FAILED'});
        await expect(readAdoptionSource('operation', null, 1, async () => undefined, journal)).rejects.toThrow('DREAM_EXECUTION_UNVERIFIED');
        let calls = 0;
        await expect(readAdoptionSource('operation', null, 1, async () => {if (++calls === 2) throw new Error('revoked'); return execution;}, journal))
            .rejects.toThrow('DREAM_SOURCE_UNAVAILABLE');
        await expect(readAdoptionSource('operation', null, 1, async () => ({...execution, dispatchId: 'other'}), journal))
            .rejects.toThrow('DREAM_ARTIFACT_INVALID');
        await expect(readAdoptionSource('operation', null, 1, async () => ({...execution, outputs: [{...outputs[0], bytes: 32769}]}), journal))
            .rejects.toThrow('DREAM_SOURCE_LIMIT');
    } finally {await journal?.drain(); await manager.dispose();}
});

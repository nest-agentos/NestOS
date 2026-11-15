import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {CellsProjectDraftStore} from '../src/projects/drafts/cells-store';
import {readConversationIdentity} from '../src/projects/drafts/remote-identity';
import type {ProjectClient} from '@nestos/cells-driver';
type Invoke = NonNullable<ProjectClient['draft']>;
const record = {version: 1 as const, id: 'node-draft', state: 'draft' as const, data: ''};
const target = {connectionId: 'c', serverProjectId: 'server-project', principalId: 'alice', profileId: 'codex'};
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/');
    const invoke = vi.fn<(...args: [Parameters<Invoke>[1]]) => ReturnType<Invoke>>(async () => ({record}));
    return {manager, fs, invoke, store: new CellsProjectDraftStore(fs, 'project', invoke)};
}
it('uses the Cells identity and data without reading or importing an old HTTP draft', async () => {
    const f = await fixture();
    try {
        await f.fs.driver.createFile({parentPath: '/var/lib/projects/project', name: 'draft.seq', type: 'seqfile', recursive: true});
        await f.fs.meta.seq!.setEntry('/var/lib/projects/project/draft.seq', 'draft', '{old HTTP draft is deliberately invalid}');
        expect(await f.store.load()).toEqual(record);
        expect(f.invoke).toHaveBeenCalledExactlyOnceWith({action: 'open'});
        expect(await f.fs.meta.seq!.getEntry('/var/lib/projects/project/draft.seq', 'draft')).toBeNull();
    } finally {await f.manager.dispose();}
});
it('freezes a node-owned draft and queries promotion without sending native input or trusting local identities', async () => {
    const f = await fixture();
    try {
        await f.store.load();
        f.invoke.mockResolvedValueOnce({record: {...record, state: 'submitting', sessionId: record.id, submissionId: 'node-operation', remoteTarget: target}});
        const prepared = await f.store.begin('Title', target);
        expect(prepared.submissionId).toBe('node-operation');
        expect(f.invoke.mock.lastCall?.[0]).toMatchObject({action: 'begin', draftId: 'node-draft', target});
        const promotion = {draftId: record.id, nextDraftId: 'next-node-draft', submissionId: 'node-operation', remoteTarget: target, nativeSessionId: 'native', turnId: 'turn'};
        f.invoke.mockResolvedValueOnce({promotion});
        expect(await f.store.promote()).toMatchObject({draftId: record.id, nextDraftId: 'next-node-draft', remote: {...target, nativeSessionId: 'native', turnId: 'turn'}});
        expect(await readConversationIdentity(f.fs, 'project', {...target, nativeSessionId: 'native'})).toBe(record.id);
        expect(f.invoke.mock.lastCall?.[0]).toMatchObject({action: 'promote', draftId: record.id});
    } finally {await f.manager.dispose();}
});
it('preserves the original identity after an unknown write and never retries the mutation', async () => {
    const f = await fixture();
    try {
        await f.store.load();
        f.invoke.mockRejectedValueOnce(Object.assign(new Error('lost acknowledgement'), {outcome: 'unknown'}));
        await expect(f.store.saveData('input')).rejects.toThrow('lost acknowledgement');
        expect(f.invoke).toHaveBeenCalledTimes(2);
        f.invoke.mockResolvedValueOnce({record: {...record, data: 'input'}});
        expect((await f.store.load()).id).toBe(record.id);
    } finally {await f.manager.dispose();}
});
it('stores and verifies chunked binary attachments on Cells, including empty content', async () => {
    const f = await fixture(), assets = new Map<string, string>();
    f.invoke.mockImplementation(async input => {
        if (input.action === 'asset_put') {assets.set(`${input.assetId}/${input.part}`, input.value!); return {stored: true};}
        if (input.action === 'asset_read') return {value: assets.get(`${input.assetId}/${input.part}`) ?? null};
        return {record};
    });
    try {
        await f.store.load();
        const bytes = new Uint8Array(110000).fill(137).buffer;
        const id = await f.store.putAttachment(bytes);
        expect(new Uint8Array(await f.store.readAttachment(id))).toEqual(new Uint8Array(bytes));
        const empty = await f.store.putAttachment(new ArrayBuffer(0));
        expect((await f.store.readAttachment(empty)).byteLength).toBe(0);
        assets.set(`${id}/1`, 'corrupt');
        await expect(f.store.readAttachment(id)).rejects.toThrow('integrity mismatch');
    } finally {await f.manager.dispose();}
});

it('retries discarded HTTP attachment cleanup without importing the old draft', async () => {
    const f = await fixture();
    const path = '/var/lib/projects/project/draft.seq', directory = '/var/lib/projects/project/draft-attachments';
    try {
        await f.fs.driver.createFile({parentPath: '/var/lib/projects/project', name: 'draft.seq', type: 'seqfile', recursive: true});
        await f.fs.meta.seq!.setEntry(path, 'draft', 'discarded HTTP draft');
        await f.fs.driver.createFile({parentPath: directory, name: 'legacy-image', content: '', recursive: true});
        const remove = vi.spyOn(f.fs.driver, 'delete').mockRejectedValueOnce(new Error('temporary cleanup error'));
        expect((await f.store.load()).id).toBe(record.id);
        expect(await f.fs.meta.seq!.getEntry(path, 'draft')).toBeNull();
        expect(await f.fs.meta.seq!.getEntry(path, 'cells-draft-legacy-cleanup')).toBe('pending');
        expect((await f.store.load()).id).toBe(record.id);
        expect(remove).toHaveBeenCalledTimes(2);
        expect(await f.fs.meta.seq!.getEntry(path, 'cells-draft-legacy-cleanup')).toBeNull();
        expect(await f.fs.driver.exists(directory)).toBe(false);
    } finally {vi.restoreAllMocks(); await f.manager.dispose();}
});

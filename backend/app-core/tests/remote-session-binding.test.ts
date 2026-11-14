import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {HarnessConversation, type HarnessClient, type HarnessProfile, type HarnessInstructionQueue} from '@nestos/cells-driver';
import {RemoteConversationStore} from '../src/projects/remote-conversation-store';
import {draftConversation, draftHarness, remoteConversationJournal} from '../src/projects/remote-draft-conversation';
import {bindConversationIdentity, readConversationIdentity} from '../src/projects/drafts/remote-identity';
import {prepareRemoteDraft} from '../src/projects/drafts/remote-submission';
import {ProjectDraftStore} from '../src/projects/drafts/store';

async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const drafts = new ProjectDraftStore(fs, 'project'), draft = await drafts.load();
    const target = {connectionId: 'connection', serverProjectId: 'project', profileId: 'profile'};
    const session = {id: 'native', title: 'Native', cwd: '/', status: 'idle', updatedAt: 1, resumable: true, owned: true};
    const profile: HarnessProfile = {id: 'profile', kind: 'native', workspaces: [{id: 'workspace'}],
        capabilities: {create: true, history: true, resume: true, interrupt: true, interactions: true}};
    let raw: string | null = null, owned = false;
    const queue: HarnessInstructionQueue = {owner: 'cells', revision: 0, paused: false, items: [], receipts: []};
    const state = {read: vi.fn(async () => raw), compare: vi.fn(async (_key: string, before: string | null, after: string | null) => {
        if (owned && after && Object.hasOwn(JSON.parse(after), 'instructionQueue'))
            throw Object.assign(new Error('HARNESS_QUEUE_OWNED_BY_CELLS'), {code: 'EIO', remoteCode: 'HARNESS_QUEUE_OWNED_BY_CELLS', outcome: 'not-committed'});
        if (raw !== before) return false;
        raw = after; return true;
    }), registerSession: vi.fn(async () => {const changed = !owned; owned = true; return changed;}),
    queueSession: vi.fn(async () => structuredClone(queue))};
    const client = {profiles: vi.fn(async () => ({epoch: 'epoch', profiles: [profile]})), subscribe: vi.fn(() => () => {}),
        create: vi.fn(async () => ({session})), read: vi.fn(async () => ({session, turns: []})),
        turn: vi.fn(async () => ({turnId: 'turn'})), operation: vi.fn(), close: vi.fn(async () => {}),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []}))} as unknown as HarnessClient;
    const prepare = vi.fn(async () => {await prepareRemoteDraft(fs, 'project', draft.id, target);});
    const open = () => {
        const recovery = new RemoteConversationStore(fs, draft.id, state,
            nativeSessionId => bindConversationIdentity(fs, 'project', {...target, nativeSessionId}, draft.id));
        const journal = remoteConversationJournal(recovery, 'epoch', true, () => {}, undefined, prepare);
        return draftConversation(new HarnessConversation(draftHarness(client, recovery), profile, 'workspace', undefined, true, journal), recovery);
    };
    return {manager, fs, draft, target, state, client, prepare, open, raw: () => raw};
}

it('binds the stable host draft only on sending, retains it after rejection, and reuses the native session on reopening', async () => {
    const f = await fixture(); let view = f.open();
    try {
        await view.read(); await view.saveDraft('Keep input');
        expect(f.client.create).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
        expect((await new ProjectDraftStore(f.fs, 'project').load()).state).toBe('draft');
        vi.mocked(f.client.turn).mockRejectedValueOnce({outcome: 'not-committed', code: 'HARNESS_SESSION_BUSY'});
        await expect(view.send('Keep input', [], undefined, 'first-input')).rejects.toMatchObject({outcome: 'not-committed'});
        expect(await readConversationIdentity(f.fs, 'project', {...f.target, nativeSessionId: 'native'})).toBe(f.draft.id);
        expect(JSON.parse(f.raw()!)).toMatchObject({sessionId: 'native', draft: 'Keep input'});
        expect(JSON.parse(f.raw()!)).not.toHaveProperty('instructionQueue');
        await view.close(); view = f.open(); await view.read();
        expect(await view.send('Keep input', [], undefined, 'retry-input')).toMatchObject({sessionId: 'native', draft: '', submittedTurnId: 'turn'});
        expect(f.client.create).toHaveBeenCalledOnce();
        await view.close(); view = f.open();
        expect(await view.read()).toMatchObject({sessionId: 'native', submittedTurnId: 'turn'});
        expect(f.client.create).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});

it('reconciles an admitted create after queue registration rejects metadata, without rejecting or recreating the native session', async () => {
    const f = await fixture(), view = f.open();
    try {
        await view.read();
        f.state.registerSession.mockRejectedValueOnce(Object.assign(new Error('Registration denied'), {code: 'EACCES', outcome: 'not-committed'}));
        await expect(view.send('Original input', [], undefined, 'input')).rejects.toMatchObject({outcome: 'unknown'});
        expect(view.snapshot()).toMatchObject({pending: true, draft: 'Original input'});
        expect(f.client.turn).not.toHaveBeenCalled();
        vi.mocked(f.client.operation).mockImplementation(async (_profile, requestId) => ({requestId, outcome: 'committed', result: {session: {id: 'native', title: 'Native', cwd: '/', status: 'idle', updatedAt: 1, resumable: true, owned: true}}}));
        await view.reconcile();
        expect(view.snapshot()).toMatchObject({pending: false, draft: 'Original input'});
        await view.send('Original input', [], undefined, 'next-input');
        expect(f.client.create).toHaveBeenCalledOnce(); expect(f.client.turn).toHaveBeenCalledOnce();
    } finally {await view.close(); await f.manager.dispose();}
});

it('keeps newer input while an accepted first turn is in flight', async () => {
    const f = await fixture(), view = f.open(); let finish!: (result: {turnId: string}) => void;
    try {
        await view.read();
        vi.mocked(f.client.turn).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
        const sending = view.send('Original', [], undefined, 'original');
        await vi.waitFor(() => expect(f.client.turn).toHaveBeenCalledOnce());
        await view.saveDraft('Later input'); finish({turnId: 'turn'}); await sending;
        expect(view.snapshot()).toMatchObject({sessionId: 'native', draft: 'Later input', submittedTurnId: 'turn'});
        expect(JSON.parse(f.raw()!)).toMatchObject({draft: 'Later input'});
        expect(JSON.parse(f.raw()!)).not.toHaveProperty('instructionQueue');
    } finally {finish?.({turnId: 'turn'}); await view.close(); await f.manager.dispose();}
});

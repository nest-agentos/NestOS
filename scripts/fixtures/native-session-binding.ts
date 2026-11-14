import {createVFS, MemoryBackend} from '../../libraries/vfs-core/src/index';
import {HarnessConversation, type HarnessClient, type HarnessProfile} from '../../libraries/cells-driver/src/index';
import {createOperationLedger} from '../../libraries/llm-ui/src/index';
import {createNativeChatBinding, createNativeChatView} from '../../ui/llm-ui-adapter/src/independent/native';
import {observeConversation} from '../../backend/app-core/src/projects/conversation-view';
import {RemoteConversationStore} from '../../backend/app-core/src/projects/remote-conversation-store';
import {draftConversation, draftHarness, remoteConversationJournal} from '../../backend/app-core/src/projects/remote-draft-conversation';
import {remoteClientState} from '../../backend/app-core/src/projects/remote-client-state';
import {bindConversationIdentity, readConversationIdentity} from '../../backend/app-core/src/projects/drafts/remote-identity';
import {ProjectDraftStore} from '../../backend/app-core/src/projects/drafts/store';
import {prepareRemoteDraft} from '../../backend/app-core/src/projects/drafts/remote-submission';

const wait = async (ready: () => boolean) => {
    for (let i = 0; i < 1000; i++) {if (ready()) return; await new Promise(resolve => setTimeout(resolve, 5));}
    throw Error('BINDING_NOT_READY');
};
async function run() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}), fs = await manager.openFileSystem('/');
    const draft = await new ProjectDraftStore(fs, 'project').load();
    const target = {connectionId: 'connection', serverProjectId: 'project', profileId: 'native'};
    const rows = new Map<string, string>(), calls: string[] = [], metrics: unknown[] = [];
    const profile: HarnessProfile = {id: 'native', kind: 'codex', workspaces: [{id: 'project'}],
        capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    const session = {id: 'native-session', title: 'Bound session', cwd: '/', status: 'idle', updatedAt: 1, resumable: true, owned: true};
    let created = 0, turns = 0, owned = false;
    const call = async <T>(name: string, action: () => T): Promise<T> => {calls.push(name); return action();};
    // Inject the node API while exercising the real state transport, host adapter and UI.
    const node = {clientState: async (_project: unknown, input: {key: string; action: string; expected?: string | null; value?: string | null}) => call('state.' + input.action, () => {
        if (input.action === 'read') return {value: rows.get(input.key) ?? null};
        if (owned && input.key.endsWith('/recovery') && input.value && Object.hasOwn(JSON.parse(JSON.parse(input.value).text), 'instructionQueue')) throw Error('HARNESS_QUEUE_OWNED_BY_CELLS');
        if ((rows.get(input.key) ?? null) !== input.expected) return {applied: false};
        if (input.value == null) rows.delete(input.key); else rows.set(input.key, input.value);
        return {applied: true};
    }), registerSession: async () => call('session.register', () => {owned = true; return true;}),
    queueSession: async () => call('queue.read', () => ({owner: 'cells', revision: 0, paused: false, items: [], receipts: []}))};
    const client = {profiles: () => call('profiles', () => ({epoch: 'epoch', profiles: [profile]})), subscribe: () => () => {},
        create: () => call('create', () => {created++; return {session};}),
        read: () => call('history', () => ({session, turns: turns ? [{id: 'turn', status: 'completed', items: [{id: 'user', type: 'userMessage', text: 'First input'}]}] : []})),
        turn: () => call('turn', () => {turns++; return {turnId: 'turn'};}),
        eventSnapshot: () => call('events', () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []})),
        operation: async () => ({}), close: async () => {}} as unknown as HarnessClient;
    const state = remoteClientState(node as never, {id: 'project', revision: 1} as never, draft.id, () => {}, profile.id);
    const store = new RemoteConversationStore(fs, draft.id, state,
        nativeSessionId => bindConversationIdentity(fs, 'project', {...target, nativeSessionId}, draft.id));
    const journal = remoteConversationJournal(store, 'epoch', false, () => {}, undefined,
        async () => {await prepareRemoteDraft(fs, 'project', draft.id, target);});
    const controls = observeConversation(draftConversation(new HarnessConversation(draftHarness(client, store), profile, 'project', undefined, true, journal), store), undefined, draft.id);
    const editor = document.getElementById('editor')!, operations = createOperationLedger();
    const measure = async (operation: string, action: () => Promise<void>) => {
        calls.length = 0; const started = performance.now(); await action();
        const row = {operation, durationMs: Math.round((performance.now() - started) * 100) / 100, logicalApiCalls: calls.length, httpRequests: 0, methods: [...calls]};
        metrics.push(row); if (row.durationMs >= 5000 || row.logicalApiCalls >= 30) throw Error('PERFORMANCE_LIMIT:' + operation);
    };
    let binding: Awaited<ReturnType<typeof createNativeChatBinding>>, view: Awaited<ReturnType<typeof createNativeChatView>>;
    await measure('cold.open-draft', async () => {
        binding = await createNativeChatBinding({conversationId: draft.id, controls, operations, reconcile: async () => ({status: 'unknown', operationId: 'unused'})});
        view = await createNativeChatView(editor, binding);
        await wait(() => !!editor.querySelector('textarea') && !editor.querySelector<HTMLTextAreaElement>('textarea')!.disabled);
    });
    if (created || (await new ProjectDraftStore(fs, 'project').load()).state !== 'draft') throw Error('READ_CREATED_SESSION');
    const textarea = editor.querySelector('textarea');
    view!.setText('First input');
    await measure('warm.first-send', async () => {
        editor.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await wait(() => operations.getSnapshot().some(row => row.status === 'accepted') && !view!.inputBusy && controls.snapshot().messages.some(row => row.role === 'user' && row.id === 'user') && !!editor.textContent?.includes('First input'));
    });
    if (!controls.snapshot().messages.some(row => row.role === 'user' && row.id === 'user') || !editor.textContent?.includes('First input')) throw Error('NATIVE_HISTORY_NOT_RENDERED');
    if (created !== 1 || turns !== 1 || editor.querySelector('textarea') !== textarea || view!.getDraft().text) throw Error('PROMOTION_CHANGED_UI_OR_REPLAYED');
    if (await readConversationIdentity(fs, 'project', {...target, nativeSessionId: session.id}) !== draft.id) throw Error('HOST_IDENTITY_CHANGED');
    await view!.destroy(); binding!.dispose(); await controls.close();
    await measure('warm.open-existing-kanban-session', async () => {
        const existing = observeConversation(new HarnessConversation(client, profile, 'project', session.id, true,
            remoteConversationJournal(new RemoteConversationStore(fs, 'existing', state), 'epoch', false, () => {}, session.id)), undefined, draft.id);
        const next = await createNativeChatBinding({conversationId: draft.id, controls: existing, operations,
            reconcile: async operationId => ({status: 'unknown', operationId})});
        const nextView = await createNativeChatView(editor, next);
        await wait(() => !!editor.querySelector('textarea') && !editor.querySelector<HTMLTextAreaElement>('textarea')!.disabled);
        if (created !== 1) throw Error('EXISTING_SESSION_RECREATED');
        await nextView.destroy(); next.dispose(); await existing.close();
    });
    await manager.dispose();
    document.getElementById('result')!.textContent = JSON.stringify({result: 'passed',
        environment: 'Chrome headless; real NestOS state adapter, cells-driver and llm-ui DOM; injected Cells API; no HTTP transport',
        dataset: {drafts: 1, sessions: 1, turns: 1, backgroundLoad: 'none'}, metrics});
}
void run().catch(error => {document.getElementById('result')!.textContent = JSON.stringify({result: 'failed', code: error instanceof Error ? error.message : 'UNKNOWN'});});

import {expect, it, vi} from 'vitest';
import {FSError} from '@nestos/vfs-core';
import type {ApplicationBackend, LocalApplicationServices} from '@nestos/app-contracts/services';
import {ConversationWorkbench} from '../../src/host/conversation-workbench';

function fixture() {
    const stop = vi.fn(), subscribe = vi.fn(() => stop), nativeListeners = new Set<() => void>();
    const snapshot = {sessionId: 'native', title: 'Native', messages: [], requests: [], pending: false, supportsModels: true, supportsSlashCommands: true, supportsMetrics: true};
    const conversation = {kind: 'native', snapshot: () => snapshot, read: vi.fn(async () => snapshot),
        readComposerDraft: vi.fn(async () => ({revision: 'r1', data: '{}'})), models: vi.fn(async () => ({models: []})),
        commands: vi.fn(async () => []), refreshMetrics: vi.fn(async () => snapshot), close: vi.fn(async () => {}),
        subscribe: (listener: () => void) => {nativeListeners.add(listener); return () => nativeListeners.delete(listener);},
        send: vi.fn(), respond: vi.fn(), interrupt: vi.fn()};
    const project = {path: '/P', name: 'P', project: {id: 'p'}};
    const node = {path: '/', name: '', type: 'directory', parentPath: '', tags: [], metadata: {}};
    const fs = {revision: 0, onAny: subscribe, driver: {getNode: vi.fn(async () => node), getChildren: vi.fn(async () => [])}};
    const browser = {fs, readDirectory: vi.fn(async () => ({node, nodes: [], directories: [], navigation: undefined})), dispose: vi.fn(async () => {})}, connections = {update: vi.fn(async () => {}), dispose: vi.fn(async () => {})};
    const projects = {favorites: {subscribe}, drafts: {onPromoted: subscribe}, forFolder: vi.fn(async () => project),
        navigation: vi.fn(async () => ({projects: [project], path: '/', loadPaths: [], offlineProjectIds: [], pendingDeletions: 0})),
        remoteMounts: {onChange: subscribe, list: () => [], projectConversation: vi.fn(async () => conversation)}};
    const services = {sessionRepository: {subscribe}, sessionFiles: {subscribe}, kernel: {kernel: {onChanged: subscribe}},
        sessionManager: {onEvent: subscribe, onGlobalEvent: subscribe, getSnapshot: () => ({})}, agentService: {onChange: subscribe}, projects} as unknown as LocalApplicationServices;
    const backend = {workbenchView: vi.fn(async () => ({browser, connections, lifecycle: {}})), readUiDocuments: vi.fn(async () => ({layout: {version: 1}}))} as unknown as ApplicationBackend;
    return {services, backend, projects, conversation, nativeListeners, browser, connections, stop};
}
const request = {resourceId: '/folder:P/@harness/native/native', documents: ['layout']};
it('prepares fresh read models, observes once and releases all owned resources', async () => {
    const f = fixture(), view = await new ConversationWorkbench(f.services).initialize(f.backend, request);
    expect(view.documents).toEqual({layout: {version: 1}}); expect(view.native?.draft).toEqual({revision: 'r1', data: '{}'});
    for (const method of ['read', 'readComposerDraft'] as const) expect(f.conversation[method]).toHaveBeenCalledOnce();
    for (const method of ['models', 'commands', 'refreshMetrics'] as const) expect(f.conversation[method]).not.toHaveBeenCalled();
    expect(view.native?.deferredMetadata).toBe(true);
    expect(f.backend.workbenchView).toHaveBeenCalledWith(expect.objectContaining({chatControls: false, initialNavigation: false}));
    expect(f.projects.forFolder).toHaveBeenCalledExactlyOnceWith('/P');
    expect(f.connections.update).toHaveBeenCalledOnce();
    expect(f.conversation.send).not.toHaveBeenCalled(); expect(f.conversation.respond).not.toHaveBeenCalled(); expect(f.conversation.interrupt).not.toHaveBeenCalled();
    const received = vi.fn(), off = await view.subscribe(received);
    for (const listener of f.nativeListeners) listener();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({topic: 'conversation', value: {resourceId: request.resourceId}}));
    off(); await view.dispose(); await view.dispose();
    expect(f.conversation.close).toHaveBeenCalledOnce(); expect(f.browser.dispose).toHaveBeenCalledOnce(); expect(f.connections.dispose).toHaveBeenCalledOnce(); expect(f.nativeListeners.size).toBe(0);
});
it('keeps a denied conversation local to its view while navigation and another conversation remain usable', async () => {
    const f = fixture(); f.conversation.read.mockRejectedValueOnce(new FSError('EACCES', 'Denied'));
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, request);
    expect(view.failure?.code).toBe('EACCES'); expect(view.native).toBeUndefined();
    expect(await view.readNavigation({projectId: null})).toMatchObject({statuses: {}});
    expect((await view.openConversation('/folder:P/@harness/native/other')).project.project.id).toBe('p');
    expect(view.failure).toBeUndefined(); await view.dispose();
});
it('keeps only the target project interested when the conversation fails and navigation includes other projects', async () => {
    const f = fixture(); f.conversation.read.mockRejectedValueOnce(new FSError('EACCES', 'Denied'));
    Object.assign(f.projects.remoteMounts, {list: () => [{at: '/', serverProjectId: 'native'}], sessionStatus: {subscribe: () => () => {}, records: () => []}});
    f.browser.readDirectory.mockResolvedValueOnce({node: {} as never, nodes: [], directories: [], navigation: {projects: [{project: {id: 'other'}}]} as never});
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, request);
    await view.readNavigation({projectId: null});
    expect(view.failure?.code).toBe('EACCES');
    expect(f.connections.update.mock.calls.every(([ids]) => ids.length === 1 && ids[0] === 'p')).toBe(true);
    await view.dispose();
});
it('releases late resources if closure races preparation', async () => {
    const f = fixture(); let finish!: () => void;
    f.conversation.read.mockImplementationOnce(() => new Promise(resolve => {finish = () => resolve(f.conversation.snapshot());}));
    const view = new ConversationWorkbench(f.services), opening = view.initialize(f.backend, request);
    await vi.waitFor(() => expect(f.conversation.read).toHaveBeenCalledOnce()); await view.dispose(); finish();
    await expect(opening).rejects.toMatchObject({code: 'EIO'});
    expect(f.conversation.close).toHaveBeenCalledOnce(); expect(f.browser.dispose).toHaveBeenCalledOnce();
});
it('suspends metadata interests while hidden and releases each registration once', async () => {
    const f = fixture(), released = vi.fn(), subscribe = vi.fn(() => released);
    Object.assign(f.projects.remoteMounts, {sessionStatus: {subscribe, records: () => []}});
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, request);
    expect(subscribe).toHaveBeenCalledOnce(); await view.setVisible(false);
    expect(released).toHaveBeenCalledOnce(); expect(f.connections.update).toHaveBeenLastCalledWith([], expect.any(Number));
    await view.setVisible(true); expect(subscribe).toHaveBeenCalledTimes(2);
    await view.dispose(); expect(released).toHaveBeenCalledTimes(2);
});

it('opens files through one owned observation without preparing a conversation or chat controls', async () => {
    const f = fixture(), chatFactory = vi.fn(async () => ({configuration: {subscribe: vi.fn(() => () => {}), dispose: vi.fn(async () => {})}}));
    const view = await new ConversationWorkbench(f.services, chatFactory as any).initialize(f.backend, {resourceId: '/folder:P/@files/note.md', documents: ['layout']});
    expect(f.backend.workbenchView).toHaveBeenCalledWith(expect.objectContaining({chatControls: false, initialNavigation: false}));
    expect(f.projects.remoteMounts.projectConversation).not.toHaveBeenCalled(); expect(chatFactory).not.toHaveBeenCalled();
    await view.readNavigation({projectId: null});
    expect(f.browser.readDirectory).toHaveBeenCalledWith('/folder:P', expect.objectContaining({includeAncestors: true}));
    const [one, two] = await Promise.all([view.prepareChat(), view.prepareChat()]);
    expect(one).toBe(two); expect(chatFactory).toHaveBeenCalledOnce();
    await view.dispose(); expect(one.configuration!.dispose).toHaveBeenCalledOnce();
});
it('registers the file project before navigation and releases its interest', async () => {
    const f = fixture();
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, {resourceId: '/folder:P/@files/note.md', documents: []});
    expect(f.connections.update).toHaveBeenCalledWith(['p'], expect.any(Number));
    await view.setVisible(false);
    expect(f.connections.update).toHaveBeenLastCalledWith([], expect.any(Number));
    await view.setVisible(true);
    expect(f.connections.update).toHaveBeenLastCalledWith(['p'], expect.any(Number));
    await view.dispose(); expect(f.connections.dispose).toHaveBeenCalledOnce();
});
it('resolves a project folder route before registering its connection interest', async () => {
    const f = fixture();
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, {resourceId: '/folder:P', documents: []});
    expect(f.projects.forFolder).toHaveBeenCalledWith('/P');
    expect(f.connections.update).toHaveBeenCalledWith(['p'], expect.any(Number));
    await view.dispose();
});
it('closes late lazy chat preparation and never publishes it into a disposed workbench', async () => {
    const f = fixture(), dispose = vi.fn(async () => {}); let finish!: () => void;
    const chatFactory = vi.fn(() => new Promise<any>(resolve => {finish = () => resolve({configuration: {dispose}});}));
    const view = await new ConversationWorkbench(f.services, chatFactory).initialize(f.backend, {resourceId: '/folder:P/@files/note.md', documents: []});
    const opening = view.prepareChat(); await view.dispose(); finish();
    await expect(opening).rejects.toMatchObject({code: 'EIO'}); expect(dispose).toHaveBeenCalledOnce(); expect(view.workbench.chat).toBeUndefined();
});
it('releases observations and the prepared browser when document loading fails', async () => {
    const f = fixture(); vi.mocked(f.backend.readUiDocuments).mockRejectedValueOnce(new FSError('EACCES', 'Denied'));
    await expect(new ConversationWorkbench(f.services).initialize(f.backend, {resourceId: '/folder:P/@files/note.md', documents: ['layout']})).rejects.toMatchObject({code: 'EACCES'});
    expect(f.browser.dispose).toHaveBeenCalledOnce(); expect(f.stop).toHaveBeenCalled(); expect(f.projects.remoteMounts.projectConversation).not.toHaveBeenCalled();
});
it('shares the cold file view observation instead of attaching a second set of domain sources', async () => {
    const {openView} = await import('../../src/host/open-view');
    const f = fixture(), resourceId = '/folder:P/@files/note.md';
    const opening = await openView(f.services, f.backend, {resourceId, documents: [], workbench: {initialNavigation: false}},
        request => new ConversationWorkbench(f.services).initialize(f.backend, request));
    expect(opening.conversationWorkbench?.native).toBeUndefined(); expect(opening.workbench.chat).toBeUndefined();
    expect(opening.observation.getViewCursor()).toBe(opening.conversationWorkbench?.cursor);
    await opening.dispose(); expect(f.stop).toHaveBeenCalledTimes(10); expect(f.browser.dispose).toHaveBeenCalledOnce();
});

it('captures the global event baseline before preparing any cold file snapshot', async () => {
    const {openView} = await import('../../src/host/open-view');
    const f = fixture(), baseline = {streamId: 'events', sequence: 3}, eventBaseline = vi.fn(async () => baseline);
    Object.assign(f.services, {events: {eventBaseline}});
    const opening = await openView(f.services, f.backend, {resourceId: '/folder:P/@files/note.md', documents: [], workbench: {}},
        request => new ConversationWorkbench(f.services).initialize(f.backend, request));
    expect(opening.eventBaseline).toBe(baseline);
    expect(eventBaseline.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(f.backend.workbenchView).mock.invocationCallOrder[0]);
    await opening.dispose();
});

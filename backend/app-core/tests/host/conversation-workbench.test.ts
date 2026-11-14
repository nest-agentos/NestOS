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
    for (const method of ['read', 'readComposerDraft', 'models', 'commands', 'refreshMetrics'] as const) expect(f.conversation[method]).toHaveBeenCalledOnce();
    expect(f.conversation.send).not.toHaveBeenCalled(); expect(f.conversation.respond).not.toHaveBeenCalled(); expect(f.conversation.interrupt).not.toHaveBeenCalled();
    const received = vi.fn(), off = await view.subscribe(received);
    for (const listener of f.nativeListeners) listener();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({topic: 'conversation', value: {resourceId: request.resourceId}}));
    off(); await view.dispose(); await view.dispose();
    expect(f.conversation.close).toHaveBeenCalledOnce(); expect(f.browser.dispose).toHaveBeenCalledOnce(); expect(f.connections.dispose).toHaveBeenCalledOnce(); expect(f.nativeListeners.size).toBe(0);
});
it('keeps optional metadata failures separate and bounds a non-settling metadata source', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.conversation.models.mockRejectedValueOnce(new FSError('EACCES', 'Private metadata'));
    f.conversation.commands.mockImplementationOnce(() => new Promise(() => {}));
    try {
        const opening = new ConversationWorkbench(f.services).initialize(f.backend, request);
        await vi.advanceTimersByTimeAsync(1500); const view = await opening;
        expect(view.native?.issues).toEqual({models: 'EACCES', commands: 'WORKBENCH_METADATA_TIMEOUT'});
        expect(view.native?.conversation.snapshot().sessionId).toBe('native'); expect(view.failure).toBeUndefined();
        await view.dispose();
    } finally {vi.useRealTimers();}
});
it('keeps a denied conversation local to its view while navigation and another conversation remain usable', async () => {
    const f = fixture(); f.conversation.read.mockRejectedValueOnce(new FSError('EACCES', 'Denied'));
    const view = await new ConversationWorkbench(f.services).initialize(f.backend, request);
    expect(view.failure?.code).toBe('EACCES'); expect(view.native).toBeUndefined();
    expect(await view.readNavigation({projectId: null})).toMatchObject({statuses: {}});
    expect((await view.openConversation('/folder:P/@harness/native/other')).project.project.id).toBe('p');
    expect(view.failure).toBeUndefined(); await view.dispose();
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

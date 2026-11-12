import {createSessionActivityReader} from '@nestos/llm-session';
import {afterEach, expect, it, vi} from 'vitest';
import {MemoryBackend} from '@nestos/vfs-core';
import {sessionDirectoryStorage} from '@nestos/llm-session';
import type {DurableTaskProgram} from '@nestos/durable-kernel';
import type {LocalApplicationServices} from '@nestos/app-contracts/services';
import {createApplicationRuntime} from '../../src/runtime/create-application-runtime';
import {openApplicationView} from '../../src/host/application-view';
import {openSessionView} from '../../src/host/session-view';
import {createLocalKanbanSessionSource} from '../../src/kanban/session-source';
import {coldQuery} from '../helpers/cold-query';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close();});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function fixture() {
    const runtime = await createApplicationRuntime({backend: new MemoryBackend(), ownerKind: 'cli', digitalTwinAutoStart: false});
    cleanup.push(() => runtime.dispose());
    const id = await runtime.projects.sessions.create('Target', null);
    return {runtime, id};
}
it('opens a direct initial target without listing unrelated Sessions or reading their histories', async () => {
    const {runtime, id} = await fixture(), client = await openApplicationView(runtime); cleanup.push(() => client.close());
    const all = vi.spyOn(runtime.sessionRepository, 'listSummaries').mockRejectedValue(new Error('Unbounded Session enumeration'));
    const navigation = vi.spyOn(runtime.projects, 'navigation').mockRejectedValue(new Error('Unrequested navigation'));
    const history = vi.spyOn(runtime.kernel.kernel, 'taskHistory').mockRejectedValue(new Error('Unrequested task history'));
    const workspace = await client.backend.workbenchView({initialNavigation: false, initialSessionId: id});
    expect(workspace.initialSession?.manifest.id).toBe(id);
    expect(all).not.toHaveBeenCalled(); expect(navigation).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
});
it('starts independent project and workspace checks together and reads each once', async () => {
    const project = deferred<undefined>(), workspace = deferred<undefined>();
    const getManifest = vi.fn(async () => ({id: 'target', folder: '/target'}));
    const forFolder = vi.fn(() => project.promise), fixedWorkspace = vi.fn(() => workspace.promise);
    const release = vi.fn(async () => {}), acquireFiles = vi.fn(async () => ({context: {}, release}));
    const work = openSessionView({sessionRepository: {getManifest}, projects: {forFolder}, directoryMounts: {fixedWorkspace},
        sessionFiles: {acquireFiles}} as unknown as LocalApplicationServices, 'target');
    await vi.waitFor(() => {expect(forFolder).toHaveBeenCalledOnce(); expect(fixedWorkspace).toHaveBeenCalledOnce();});
    expect(acquireFiles).not.toHaveBeenCalled(); project.resolve(undefined); workspace.resolve(undefined);
    const view = await work; await view.dispose();
    expect(getManifest).toHaveBeenCalledOnce(); expect(acquireFiles).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
});
it('reads a running Session summary without waiting for its business Effect or opening another execution', async () => {
    const {runtime, id} = await fixture(), kernel = runtime.kernel.kernel, entered = deferred<void>(), finish = deferred<number>();
    const program: DurableTaskProgram = {manifest: {kind: 'performance-hold', version: '1'},
        init: () => ({state: null, actions: [{type: 'effect', effect: {id: 'hold', kind: 'performance-hold', version: '1', request: null, idempotencyKey: 'hold'}}], next: {type: 'wait', on: {type: 'effect', id: 'hold'}}}),
        reduce: state => ({state, next: {type: 'complete'}})};
    kernel.registerProgram(program); kernel.registerEffect({kind: 'performance-hold', version: '1', execute: async () => {entered.resolve(); return finish.promise;}});
    const session = await kernel.createSession({id, storage: sessionDirectoryStorage(id)});
    const task = await session.submit({program: program.manifest, input: null}); await entered.promise;
    const events = vi.spyOn(kernel, 'readEvents'), history = vi.spyOn(kernel, 'taskHistory');
    const manifest = vi.spyOn(runtime.sessionRepository, 'getManifest');
    try {
        const source = createLocalKanbanSessionSource(runtime.sessionRepository,createSessionActivityReader(kernel));
        const result = await coldQuery(kernel, () => source.inspect({id: 'board'} as never, id));
        expect(result.sessionId).toBe(id); expect((await task.status()).task.exit).toBeUndefined();
        expect(manifest).toHaveBeenCalledExactlyOnceWith(id); expect(events).not.toHaveBeenCalled(); expect(history).not.toHaveBeenCalled();
    } finally {finish.resolve(1); await task.wait({until: 'settled', timeoutMs: 2000});}
});

it('coalesces concurrent folder reads during preparation without retaining a stale cache', async () => {
    const {runtime} = await fixture(), list = vi.spyOn(runtime.sessionRepository, 'listFolders');
    await Promise.all([runtime.projects.forFolder('/target'), runtime.projects.forFolder('/target'), runtime.projects.forFolder('/target')]);
    expect(list).toHaveBeenCalledOnce();
    await runtime.projects.forFolder('/target'); expect(list).toHaveBeenCalledTimes(2);
});

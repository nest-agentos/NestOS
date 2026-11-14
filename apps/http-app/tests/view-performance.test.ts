import { afterEach, expect, it, vi } from 'vitest';
import { RpcPeer } from '@nestos/app-transport/application';
import { installViewProjections } from '@nestos/app-transport/application';
import { QueryBatcher } from '@nestos/app-transport/http';
import { ViewNotifications } from '@nestos/node-host/http';
import type { ServerResponse } from 'node:http';
import type { Call, Reply, WireValue } from '@nestos/app-transport/rpc';
import {observeConversation} from '../../../backend/app-core/src/projects/conversation-view';

const peers: RpcPeer[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(peers.splice(0).map(peer => peer.close())); });
async function pair(value: unknown) {
    let client!: RpcPeer;const calls:Call[]=[];
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', call => {calls.push(call);return server.handle(call);}, undefined, installViewProjections);
    peers.push(server, client);
    const boot = await server.bootstrap(value); client.applyUpdates(boot.updates);
    return { server, client, root: client.decode(boot.value!),calls };
}
function models() {
    let changed = () => {};
    const providers = [{ id: 'provider', name: 'Before', implementation: 'test', baseURL: '', models: [] }];
    return { providers, changed: () => changed(), getConnections: async () => [], saveConnection: async () => {},
        getProviders: vi.fn(() => providers), listConnections: vi.fn(() => []),
        getFullProvider: async (id: string) => providers.find(provider => provider.id === id),
        onChange: (listener: () => void) => { changed = listener; return () => { changed = () => {}; }; } };
}
it('does not recompute unrelated configuration snapshots for repeated reads or file writes', async () => {
    const model = models();
    const files = { getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {} };
    const { root } = await pair({ model, files }); model.getProviders.mockClear();
    for (let index = 0; index < 10; index++) await root.files.getNode('/file');
    await root.files.writeContent('/file', 'new content');
    expect(model.getProviders).not.toHaveBeenCalled();
    model.providers[0].name = 'After'; model.changed();
    await root.files.getNode('/file');
    expect(model.getProviders).toHaveBeenCalledTimes(1);
    expect(root.model.getProvider('provider').name).toBe('After');
});
it('keeps concurrent subscription callbacks alive when another request releases its temporary callback', async () => {
    const listeners = new Set<(event: unknown) => void>(), revision = vi.fn(), event = vi.fn();
    const files = { getChildren: async () => [], search: async () => [], writeContent: async () => {},
        getNode: async (_path: string, options: any) => { await new Promise(resolve => setTimeout(resolve, 0)); await options.onRevision(1); return null; },
        onAny: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
    const { root } = await pair(files);
    const read = root.getNode('/', { onRevision: revision });
    const stop = root.onAny(event); await read;
    for (const listener of listeners) listener('changed');
    await vi.waitFor(() => expect(event).toHaveBeenCalledWith('changed'));
    expect(revision).toHaveBeenCalledWith(1); stop();
});
it('keeps supported transaction reads on their active transaction instead of the query batch path', async () => {
    const contents = new Map<string, string>();
    const tx = { getNode: async () => null, createFile: async () => ({ path: '/file' }), delete: async () => {},
        writeContent: async (path: string, value: string) => { contents.set(path, value); }, readContent: async (path: string) => contents.get(path) };
    const files = { getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {},
        transaction: async (callback: (value: typeof tx) => Promise<void>) => callback(tx) };
    const { root, client } = await pair(files);
    await root.transaction(async (transaction: any) => {
        const ref = await client.expose(transaction) as { $ref: string };
        expect(client.remoteQuery({ target: ref.$ref, method: 'readContent', args: ['/file'] })).toBe(false);
        const node = await transaction.createFile({ name: 'file', parentPath: '/' });
        await transaction.writeContent(node.path, 'committed');
        expect(await transaction.readContent(node.path)).toBe('committed');
    });
    expect(contents.get('/file')).toBe('committed');
});
function session() {
    let changed = () => {};
    const snapshot = { sessionId: 'session', messages: [{ content: 'history '.repeat(4096) }] };
    return { snapshot, changed: () => changed(), getSnapshot: vi.fn(() => snapshot), getSessions: () => [],
        onGlobalEvent: (listener: () => void) => { changed = listener; return () => { changed = () => {}; }; } };
}
it('coalesces streaming changes and sends token deltas instead of repeating long history', async () => {
    const manager = session(); manager.snapshot.messages.push({ content: 'unchanged message' });
    const { root, server, client } = await pair(manager), unchanged = root.getSnapshot().messages[1];
    manager.getSnapshot.mockClear();
    for (let index = 0; index < 100; index++) { manager.snapshot.messages[0].content += 'token '; manager.changed(); }
    const updates = await server.refresh();
    expect(manager.getSnapshot).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(updates).length).toBeLessThan(1500);
    expect(JSON.stringify(updates)).toContain('$patch');
    client.applyUpdates(updates);
    expect(root.getSnapshot()).toEqual(manager.snapshot);
    expect(root.getSnapshot().messages[1]).toBe(unchanged);
});
it('carries a long native answer through subscription patches and explicit refresh', async () => {
    const state = {messages: [{id: 'a', role: 'assistant', text: 'Long native answer. '.repeat(8192)}], requests: [], active: true};
    const source = {kind: 'codex', snapshot: () => state, read: async () => state, refresh: async () => state, subscribe: () => () => {},
        respond: async () => state, close: async () => {}};
    const view = observeConversation(source as never);
    try {
        const {root, server, client} = await pair(view);
        const stop = root.subscribe(() => {}); await client.whenIdle();
        const before = await root.read();
        expect(before.messages[0].text).toBe(state.messages[0].text);
        state.messages[0].text += ' streamed-tail'; await view.refresh(); await server.whenIdle();
        const updates = await server.refresh(); client.applyUpdates(updates);
        expect(root.snapshot().messages[0].text).toBe(state.messages[0].text);
        expect(JSON.stringify(updates).length).toBeLessThan(2048);
        state.messages[0].text += ' refreshed-tail';
        expect((await root.read()).messages[0].text).toBe(state.messages[0].text);
        expect(before.messages[0].text).not.toContain('streamed-tail'); stop(); await client.whenIdle();
    } finally {await view.close();}
});
it('buffers out-of-order view patches and ignores stale snapshots', async () => {
    const manager = session(); const { root, server, client } = await pair(manager);
    manager.snapshot.messages[0].content += ' first'; manager.changed(); const first = await server.refresh();
    manager.snapshot.messages[0].content += ' second'; manager.changed(); const second = await server.refresh();
    client.applyUpdates(second);
    expect(root.getSnapshot().messages[0].content).not.toContain(' second');
    client.applyUpdates(first); await client.waitUpdates(second);
    expect(root.getSnapshot()).toEqual(manager.snapshot);
    client.applyUpdates(first); expect(root.getSnapshot()).toEqual(manager.snapshot);
});
it('refreshes previously requested remote status lookups after a scoped subscription event', async () => {
    const listeners = new Set<() => void>(); let observation = { execution: 'idle' };
    const status = { fileVersion: () => undefined, record: () => ({ observation }), get: () => observation,
        subscribe: (project: string, listener: () => void) => { expect(project).toBe('project'); listeners.add(listener); return () => listeners.delete(listener); } };
    const { root, server, client } = await pair(status);
    const release = root.subscribe('project', () => {});
    expect(root.get('project', 'profile', 'session')).toBeUndefined();
    await vi.waitFor(() => expect(root.get('project', 'profile', 'session')).toEqual({ execution: 'idle' }));
    observation = { execution: 'running' }; for (const listener of listeners) listener();
    client.applyUpdates(await server.refresh());
    expect(root.get('project', 'profile', 'session')).toEqual({ execution: 'running' }); release();
});
it('batches independent queries with a bound and preserves individual errors', async () => {
    const send = vi.fn(async (calls: Call[]): Promise<Reply[]> => calls.map(call => call.method === 'missing'
        ? { error: { name: 'Error', message: 'missing' } } : { value: call.args[0] }));
    const batcher = new QueryBatcher(send, () => {});
    const replies = await Promise.all(Array.from({ length: 65 }, (_, index) => batcher.query({ target: 'query', method: index === 2 ? 'missing' : 'read', args: [index] })));
    expect(send.mock.calls.map(([calls]) => calls.length)).toEqual([32, 32, 1]);
    expect(replies[2].error?.message).toBe('missing'); expect(replies[64].value).toBe(64);
});
it('keeps a slow capability query from blocking a different capability in the same turn', async () => {
    let release!: () => void;
    const slow = new Promise<void>(resolve => {release = resolve;});
    const send = vi.fn(async (calls: Call[]): Promise<Reply[]> => {
        if (calls[0].target === 'overview') await slow;
        return calls.map(() => ({value: 'ready'}));
    });
    const batcher = new QueryBatcher(send, () => {});
    const pending = batcher.query({target: 'overview', method: 'read', args: []});
    const fast = batcher.query({target: 'board', method: 'read', args: []});
    try {expect(await fast).toMatchObject({value: 'ready'}); expect(send.mock.calls.map(([calls]) => calls.map(call => call.target))).toEqual([['overview'], ['board']]);}
    finally {release(); await pending; batcher.close();}
});
it('sends ordered notifications with one snapshot refresh per event batch', async () => {
    vi.useFakeTimers(); const write = vi.fn(), refresh = vi.fn(async (): Promise<WireValue[]> => []);
    const queue = new ViewNotifications(() => ({ write, writableLength: 0, destroyed: false } as unknown as ServerResponse), refresh, error => { throw error; });
    for (let index = 0; index < 100; index++) await queue.enqueue({ target: 'listener', method: 'call', args: [index], notification: true });
    await vi.advanceTimersByTimeAsync(16);
    expect(refresh).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
    const packet = JSON.parse(write.mock.calls[0][0].slice(6)); expect(packet.calls.map((call: Call) => call.args[0])).toEqual(Array.from({ length: 100 }, (_, index) => index));
    queue.close();
});
it('bounds all notification batches while refresh is blocked and coalesces repeated invalidations', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const refresh = vi.fn(async () => { await blocked; return []; });
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, refresh, error => { throw error; });
    await queue.enqueue({ target: 'event', method: 'call', args: [0] }); await vi.advanceTimersByTimeAsync(16);
    for (let index = 1; index <= 200; index++) {
        await queue.enqueue({ target: 'event', method: 'call', args: [index] }); await queue.enqueue();
        await vi.advanceTimersByTimeAsync(16);
    }
    expect(refresh).toHaveBeenCalledTimes(1); expect(stream.write).not.toHaveBeenCalled();
    resume(); await vi.advanceTimersByTimeAsync(16);
    expect(refresh).toHaveBeenCalledTimes(2);
    const values = stream.write.mock.calls.flatMap(([frame]) => JSON.parse(frame.slice(6)).calls.map((call: Call) => call.args[0]));
    expect(values).toEqual(Array.from({ length: 201 }, (_, index) => index)); queue.close();
});
it('includes in-flight notification calls in the queue limit', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, () => new Promise(resolve => { resume = () => resolve([]); }), console.error);
    await queue.enqueue({ target: 'event', method: 'call', args: [] }); await vi.advanceTimersByTimeAsync(16);
    for (let index = 0; index < 256; index++) { await queue.enqueue({ target: 'event', method: 'call', args: [] }); await vi.advanceTimersByTimeAsync(16); }
    expect(stream.end).toHaveBeenCalledOnce(); resume(); await vi.advanceTimersByTimeAsync(16);
    expect(stream.write).not.toHaveBeenCalled(); queue.close();
});
it('bounds concurrent query batches while draining a large read burst', async () => {
    let active = 0, peak = 0;
    const batcher = new QueryBatcher(async calls => {
        active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 0)); active--;
        return calls.map(call => ({ value: call.args[0] }));
    }, () => {});
    const results = await Promise.all(Array.from({ length: 1024 }, (_, index) => batcher.query({ target: 'q', method: 'read', args: [index] })));
    expect(peak).toBe(2); expect(results.at(-1)?.value).toBe(1023);
});
it('treats read commands as queries without invalidating configuration', async () => {
    const model = models(), command = { execute: vi.fn(async () => []), list: () => [] };
    const { root } = await pair({ model, command }); model.getProviders.mockClear();
    await root.command.execute('session.get-sessions'); await root.command.execute('flow.draft.list');
    await root.command.execute('session.flow.invocations');
    expect(model.getProviders).not.toHaveBeenCalled();
    await root.command.execute('session.send'); expect(model.getProviders).toHaveBeenCalledOnce();
});

it('runs dynamically classified read commands while earlier subscriptions are pending and keeps writes behind them', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;}), execute = vi.fn(async () => []);
    const files = {getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {}, onAny: () => () => {}};
    let client!: RpcPeer;
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => {if (server.binding(call)) await gate; return server.handle(call);});
    peers.push(server, client);
    const boot = await server.bootstrap({files, command: {execute, list: () => []}});
    client.applyUpdates(boot.updates); const root = client.decode(boot.value!);
    const stop = root.files.onAny(() => {}), write = root.command.execute('session.send');
    try {
        await expect(root.command.execute('session.flow.invocations')).resolves.toEqual([]);
        expect(execute).toHaveBeenCalledExactlyOnceWith('session.flow.invocations');
    } finally {release(); await write; stop();}
    expect(execute.mock.calls.at(-1)).toEqual(['session.send']);
});
it('does not refresh other conversations for a session management event', async () => {
    const manager = session(), snapshot = vi.fn(() => ({ messages: [] }));
    const { server } = await pair({ manager, other: { snapshot, subscribe: () => () => {}, respond: async () => {} } }); snapshot.mockClear();
    manager.changed(); await server.refresh(); expect(snapshot).not.toHaveBeenCalled();
});
it('re-encodes only the affected message after a scoped streaming event', async () => {
    let event = (_event: unknown) => {}, reads = 0, text = 'before';
    const rows = Array.from({ length: 1000 }, (_, index) => ({ id: `m${index}`, get content() { reads++; return index === 999 ? text : 'stable'; } }));
    const manager = { getSnapshot: () => ({ sessionId: 's', sessions: rows, status: 'running' }), getSessions: () => rows,
        onGlobalEvent: () => () => {}, onEvent: (listener: typeof event) => { event = listener; return () => {}; } };
    const { root, server, client } = await pair(manager); reads = 0;
    const unchanged = root.getSessions()[0]; text = 'before token';
    event({ type: 'message:updated', payload: { messageId: 'm999', delta: ' token', field: 'output' } });
    event({ type: 'stream:content', payload: { delta: ' token' } });
    const updates = await server.refresh(); client.applyUpdates(updates);
    expect(reads).toBe(1); expect(root.getSnapshot().sessions[999].content).toBe(text);
    expect(root.getSessions()[0]).toBe(unchanged); expect(JSON.stringify(updates).length).toBeLessThan(1000);
    reads = 0; text = 'recovered'; event({ type: 'branch:switched', payload: {} });
    client.applyUpdates(await server.refresh());
    expect(reads).toBe(1000); expect(root.getSessions()[999].content).toBe('recovered');
});
it('returns a snapshot reference instead of retransmitting unchanged native history', async () => {
    const snapshot = { messages: Array.from({ length: 1000 }, (_, index) => ({ id: String(index), text: 'x'.repeat(256) })) };
    let server!: RpcPeer, client!: RpcPeer; const replies: Reply[] = [];
    server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => { const reply = await server.handle(call); replies.push(reply); return reply; }); peers.push(server, client);
    const boot = await server.bootstrap({ snapshot: () => snapshot, refresh: async () => snapshot, subscribe: () => () => {}, respond: async () => snapshot });
    client.applyUpdates(boot.updates); const root = client.decode(boot.value!);
    expect(await root.refresh()).toEqual(snapshot); expect(JSON.stringify(replies.at(-1)).length).toBeLessThan(500);
});
it('bounds notification bytes including a blocked in-flight batch', async () => {
    vi.useFakeTimers(); let resume!: () => void;
    const stream = { write: vi.fn(), end: vi.fn(), writableLength: 0, destroyed: false };
    const queue = new ViewNotifications(() => stream as unknown as ServerResponse, () => new Promise(resolve => { resume = () => resolve([]); }), console.error);
    const call = { target: 'event', method: 'call', args: ['x'.repeat(600_000)] };
    await queue.enqueue(call); await vi.advanceTimersByTimeAsync(16); await queue.enqueue(call);
    expect(stream.end).toHaveBeenCalledOnce(); resume(); await vi.advanceTimersByTimeAsync(16); expect(stream.write).not.toHaveBeenCalled();
});


it('installs earlier event bindings before commands while independent queries remain concurrent', async () => {
    let register!: () => void;
    const gate = new Promise<void>(resolve => {register = resolve;});
    const listeners = new Set<(value: string) => void>(), received = vi.fn();
    const files = {getNode: async () => null, getChildren: async () => [], search: async () => [],
        onAny: (listener: (value: string) => void) => {listeners.add(listener); return () => listeners.delete(listener);},
        writeContent: vi.fn(async () => {for (const listener of listeners) listener('completed');})};
    let client!: RpcPeer;
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => {if (server.binding(call)) await gate; return server.handle(call);});
    peers.push(server, client);
    const boot = await server.bootstrap(files); client.applyUpdates(boot.updates); const root = client.decode(boot.value!);
    const stop = root.onAny(received), sent = root.writeContent('/file', 'content');
    await expect(root.getChildren('/')).resolves.toEqual([]);
    expect(files.writeContent).not.toHaveBeenCalled();
    register(); await sent;
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith('completed'));
    stop();
});

it('projects a whole project status snapshot locally instead of issuing per-session lookups',async()=>{
    const listeners=new Set<()=>void>();
    let rows=Array.from({length:1000},(_,index)=>({profileId:'profile',sessionId:'session-'+index,title:'Session '+index,observation:{execution:'idle'}}));
    const records=vi.fn((project:string)=>project==='project'?rows:[]),get=vi.fn(),record=vi.fn();
    const status={records,get,record,fileVersion:()=>undefined,subscribe:(_project:string,listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
    const {root,server,client,calls}=await pair(status),release=root.subscribe('project',()=>{});
    for(let index=0;index<1000;index++){root.get('project','profile','session-'+index);root.record('project','profile','session-'+index);}
    await vi.waitFor(()=>expect(root.get('project','profile','session-999')).toEqual({execution:'idle'}));
    expect(calls.filter(call=>call.method==='records')).toHaveLength(1);
    expect(root.record('project','profile','session-999')).toEqual(root.record('project','profile','session-999'));expect(get).not.toHaveBeenCalled();expect(record).not.toHaveBeenCalled();
    rows=rows.map(row=>({...row,observation:{execution:'running'}}));for(const listener of listeners)listener();client.applyUpdates(await server.refresh());
    expect(root.get('project','profile','session-999')).toEqual({execution:'running'});expect(root.record('project','profile','session-999').title).toBe('Session 999');
    expect(root.get('other','profile','session-999')).toBeUndefined();await vi.waitFor(()=>expect(records).toHaveBeenCalledWith('other'));
    release();
});

it('shares remote mount change subscriptions and releases only after the last listener', async () => {
    const listeners = new Set<(event: unknown) => void>(), released = vi.fn();
    const mounts = {projectConversation: async () => null, connections: () => [],
        onChange: (listener: (event: unknown) => void) => {listeners.add(listener); return () => {listeners.delete(listener); released();};}};
    const {root, calls} = await pair(mounts), first = vi.fn(), second = vi.fn();
    const a = root.onChange(first), b = root.onChange(second);
    await vi.waitFor(() => expect(calls.filter(call => call.method === 'onChange')).toHaveLength(1));
    await Promise.all([...listeners].map(listener => listener({kind: 'status', projectId: 'work'})));
    await vi.waitFor(() => {expect(first).toHaveBeenCalledWith({kind: 'status', projectId: 'work'}); expect(second).toHaveBeenCalledOnce();});
    a(); expect(released).not.toHaveBeenCalled();
    b(); await vi.waitFor(() => expect(released).toHaveBeenCalledOnce());
});

it('delivers workbench changes through view snapshots without per-consumer subscription RPCs', async () => {
    const listeners = new Set<() => void>(); let events: any[] = [];
    const view = {documents: {}, native: undefined, workbench: {}, observation: {}, cursor: 0,
        readNavigation: vi.fn(), openConversation: vi.fn(), dispose: vi.fn(async () => {listeners.clear();}),
        eventSnapshot: () => ({cursor: events.at(-1)?.sequence ?? 0, firstSequence: events[0]?.sequence ?? 1, events}),
        subscribe: async (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);}}};
    const {root, server, client, calls} = await pair(view), first = vi.fn(), second = vi.fn();
    const a = await root.subscribe(first), b = await root.subscribe(second);
    expect(listeners.size).toBe(1); expect(calls).toHaveLength(0);
    events = [{sequence: 1, topic: 'mounts', value: {kind: 'status', projectId: 'p'}}];
    for (const listener of listeners) listener(); client.applyUpdates(await server.refresh());
    await vi.waitFor(() => {expect(first).toHaveBeenCalledWith(events[0]); expect(second).toHaveBeenCalledOnce();});
    a(); events = [...events, {sequence: 2, topic: 'conversation', value: {resourceId: '/folder:p/@harness/native/session'}}];
    for (const listener of listeners) listener(); client.applyUpdates(await server.refresh());
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(2)); expect(first).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0); b(); await root.dispose(); expect(listeners.size).toBe(0);
});
it('reports a workbench event gap and resumes at the current snapshot without replaying commands', async () => {
    const listeners = new Set<() => void>(); let firstSequence = 1, cursor = 0, events: any[] = [];
    const view = {documents: {}, workbench: {}, cursor: 0, readNavigation: vi.fn(), openConversation: vi.fn(), dispose: async () => {},
        eventSnapshot: () => ({cursor, firstSequence, events}), subscribe: async (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
    const {root, server, client, calls} = await pair(view), failed = vi.fn(), received = vi.fn(), stop = await root.subscribe(received, failed);
    cursor = 300; firstSequence = 45; events = [{sequence: cursor, topic: 'mounts', value: undefined}];
    for (const listener of listeners) listener(); client.applyUpdates(await server.refresh());
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith({code: 'WORKBENCH_OBSERVATION_GAP'})); expect(received).not.toHaveBeenCalled();
    cursor++; events = [...events, {sequence: cursor, topic: 'conversation', value: {resourceId: '/folder:p/@harness/native/session'}}];
    for (const listener of listeners) listener(); client.applyUpdates(await server.refresh());
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce()); expect(calls).toHaveLength(0); stop();
});

it('applies native request snapshots before notifying the composed workbench consumer', async () => {
    const viewListeners = new Set<() => void>(), nativeListeners = new Set<() => void>();
    let state = {sessionId: 's', requests: [{id: 'approval', kind: 'approval'}]}, events: any[] = [];
    const conversation = {snapshot: () => state, respond: vi.fn(), subscribe: (listener: () => void) => {nativeListeners.add(listener); return () => nativeListeners.delete(listener);}};
    const view = {documents: {}, workbench: {}, native: {conversation}, cursor: 0, readNavigation: vi.fn(), openConversation: vi.fn(), dispose: async () => {},
        eventSnapshot: () => ({cursor: events.at(-1)?.sequence ?? 0, firstSequence: 1, events}),
        subscribe: async (listener: () => void) => {viewListeners.add(listener); return () => viewListeners.delete(listener);}};
    const {root, server, client, calls} = await pair(view), observed = vi.fn(() => root.native.conversation.snapshot().requests.length);
    const stop = await root.subscribe(observed); state = {sessionId: 's', requests: []}; events = [{sequence: 1, topic: 'conversation', value: {resourceId: 's'}}];
    for (const listener of viewListeners) listener(); for (const listener of nativeListeners) listener();
    client.applyUpdates(await server.refresh()); await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
    expect(observed.mock.results[0].value).toBe(0); expect(calls).toHaveLength(0); stop();
});

it('waits for the opening reply when SSE patches for a new view arrive first', async () => {
    let client!: RpcPeer, deliver!: (reply: Reply) => void, opened!: (reply: Reply) => void;
    const ready = new Promise<Reply>(resolve => {opened = resolve;}), listeners = new Set<() => void>(); let events: any[] = [];
    const view = {documents: {}, workbench: {}, cursor: 0, readNavigation: vi.fn(), openConversation: vi.fn(), dispose: async () => {},
        eventSnapshot: () => ({cursor: events.at(-1)?.sequence ?? 0, firstSequence: 1, events}),
        subscribe: async (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => {
        const reply = await server.handle(call);
        if (call.method !== 'openConversationWorkbench') return reply;
        opened(reply); return new Promise(resolve => {deliver = resolve;});
    }, undefined, installViewProjections); peers.push(server, client);
    const boot = await server.bootstrap({workbenchView: vi.fn(), toolboxView: vi.fn(), taskDetails: vi.fn(), openConversationWorkbench: async () => view});
    client.applyUpdates(boot.updates); const root = client.decode(boot.value!), opening = root.openConversationWorkbench({});
    const response = await ready; events = [{sequence: 1, topic: 'mounts', value: {kind: 'status'}}];
    for (const listener of listeners) listener(); const notification = await server.refresh();
    expect(notification.some(update => update && typeof update === 'object' && '$patch' in update)).toBe(true);
    expect(() => client.applyUpdates(notification)).not.toThrow();
    const applied = client.waitUpdates(notification); deliver(response); const workspace = await opening; await applied;
    const received = vi.fn(), stop = await workspace.subscribe(received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(events[0])); stop();
});

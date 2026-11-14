import {expect, it, vi} from 'vitest';
import {RpcPeer, installViewProjections} from '@nestos/app-transport/application';
import type {Reply} from '@nestos/app-transport/rpc';

it('accepts an early SSE patch only after the original reply supplies its capability', async () => {
    let client!: RpcPeer, deliver!: (reply: Reply) => void, available!: (reply: Reply) => void;
    let state = {revision: 0, providers: [] as string[]}; const listeners = new Set<() => void>();
    const source = {getConfigurationSnapshot: () => state, dispose: async () => {},
        subscribe: (listener: () => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
    const ready = new Promise<Reply>(resolve => {available = resolve;});
    const server = new RpcPeer('server', call => client.handle(call));
    client = new RpcPeer('client', async call => {
        const reply = await server.handle(call);
        if (call.method !== 'workbenchView') return reply;
        available(reply); return new Promise(resolve => {deliver = resolve;});
    }, undefined, installViewProjections);
    try {
        const boot = await server.bootstrap({workbenchView: async () => source, toolboxView: vi.fn(), taskDetails: vi.fn()});
        client.applyUpdates(boot.updates); const root = client.decode(boot.value!), opening = root.workbenchView({});
        const response = await ready; state = {revision: 1, providers: ['ready']}; for (const listener of listeners) listener();
        const updates = await server.refresh(); expect(JSON.stringify(updates)).toContain('$patch');
        expect(() => client.applyUpdates(updates)).not.toThrow(); const applied = client.waitUpdates(updates);
        deliver(response); const view = await opening; await applied;
        expect(view.getConfigurationSnapshot()).toEqual(state);
    } finally {await Promise.all([client.close(), server.close()]);}
});
it('bounds missing bases and rejects oversized or foreign pending patches without exposing content', async () => {
    vi.useFakeTimers(); const client = new RpcPeer('client', async () => ({}));
    try {
        const patch = {$patch: {id: 'server:pending:1', baseVersion: 1, version: 2, changes: []}};
        client.applyUpdates([patch]); const applied = expect(client.waitUpdates([patch])).rejects.toMatchObject({code: 'EIO'});
        await vi.advanceTimersByTimeAsync(5001); await applied;
        expect(() => client.applyUpdates([{$patch: {...patch.$patch, id: 'client:foreign:1'}}])).toThrow('Invalid view patch identity');
        expect(() => client.applyUpdates([{$patch: {...patch.$patch, id: 'server:large:1', changes: [{path: ['fields', 'data'], value: 'x'.repeat(2 * 1024 * 1024)}]}}])).toThrow('Pending view updates exceed byte limit');
    } finally {await client.close(); vi.useRealTimers();}
});
it('drops queued notifications only for formally closed subscription callbacks', async () => {
    let client!: RpcPeer; const packets: any[] = [], listeners = new Set<(event: unknown) => void>();
    const source = {getChildren: async () => [], getNode: async () => null, writeContent: async () => {}, search: async () => [],
        onAny: (listener: (event: unknown) => void) => {listeners.add(listener); return () => listeners.delete(listener);}};
    const server = new RpcPeer('server', async call => {packets.push(call); return {};});
    client = new RpcPeer('client', call => server.handle(call), undefined, installViewProjections);
    try {
        const boot = await server.bootstrap(source); client.applyUpdates(boot.updates); const root = client.decode(boot.value!), received = vi.fn();
        const stop = root.onAny(received); await vi.waitFor(() => expect(listeners.size).toBe(2));
        for (const listener of listeners) listener({type: 'updated', path: '/'});
        await vi.waitFor(() => expect(packets).toHaveLength(1));
        stop(); await client.whenIdle();
        expect((await client.handle(packets[0])).error).toBeUndefined(); expect(received).not.toHaveBeenCalled();
        expect((await client.handle({...packets[0], notification: false})).error?.remoteCode).toBe('RPC_CAPABILITY_RETIRED');
        expect((await client.handle({...packets[0], target: 'client:unknown:999'})).error?.remoteCode).toBe('RPC_CAPABILITY_NOT_FOUND');
    } finally {await Promise.all([client.close(), server.close()]);}
});

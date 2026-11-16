import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@nestos/app-transport/application';
import {HttpViewClient} from '@nestos/app-transport/http';

const releases: Array<() => Promise<void>> = [];
afterEach(async () => {
    await Promise.all(releases.splice(0).map(release => release()));
    vi.useRealTimers(); vi.restoreAllMocks();
});

async function connection(mode: 'eof' | 'headers' | 'open' | 'silent') {
    vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = new RpcPeer('server', async () => ({})), bootstrap = await server.bootstrap({title: 'Test', files: {
        getNode: async () => null, getChildren: async () => [], search: async () => [], writeContent: async () => {}, onAny: () => () => {},
    }});
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [], commands: string[] = [];
    let subscriptions = 0, failReads = false;
    const fetcher: typeof fetch = async (_input, init) => {
        if (init?.method) {
            const {kind} = JSON.parse(String(init.body)); commands.push(kind);
            if (kind === 'queries' && failReads) throw new TypeError('Network unavailable');
            return Response.json(kind === 'bootstrap' ? bootstrap : {});
        }
        if (++subscriptions > 1 && mode === 'headers') throw new TypeError('fetch failed');
        const body = new ReadableStream<Uint8Array>({start(controller) {
            streams.push(controller);
            if (subscriptions === 1 || mode !== 'silent') controller.enqueue(new TextEncoder().encode(': connected\n\n'));
            if (subscriptions > 1 && mode === 'eof') controller.close();
        }});
        return new Response(body, {headers: {'X-NestOS-View-Resume': '1'}});
    };
    const disconnected = vi.fn(), reconnected = vi.fn();
    const client = new HttpViewClient('test', '/api/application', fetcher, disconnected, undefined, reconnected);
    releases.push(async () => {await client.close(); await server.close();});
    const root = await client.start() as any;
    return {client, root, commands, disconnected, reconnected, heartbeat: () => streams.at(-1)!.enqueue(new TextEncoder().encode(': heartbeat\n\n')),
        failReads: () => {failReads = true;}, disconnect: () => streams.at(-1)!.close(), subscriptions: () => subscriptions};
}

it.each(['eof', 'headers'] as const)('backs off repeated %s failures up to 15 seconds without replaying bootstrap', async mode => {
    const current = await connection(mode);
    current.disconnect(); await vi.advanceTimersByTimeAsync(0);
    expect(current.subscriptions()).toBe(2);
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
        const before = current.subscriptions();
        await vi.advanceTimersByTimeAsync(delay - 1); expect(current.subscriptions()).toBe(before);
        await vi.advanceTimersByTimeAsync(1); expect(current.subscriptions()).toBe(before + 1);
    }
    expect(current.commands).toEqual(['bootstrap']);
});

it('resets backoff after a stable stream instead of after successful headers', async () => {
    const current = await connection('open');
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
    current.disconnect(); await vi.advanceTimersByTimeAsync(1000); expect(current.subscriptions()).toBe(3);
    await vi.advanceTimersByTimeAsync(15000);
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(4);
    current.disconnect(); await vi.advanceTimersByTimeAsync(999); expect(current.subscriptions()).toBe(4);
    await vi.advanceTimersByTimeAsync(1); expect(current.subscriptions()).toBe(5);
});

it('wakes backoff on explicit retry and stops all further subscriptions on close', async () => {
    const current = await connection('eof');
    current.disconnect(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(3);
    await current.client.close();
    await vi.advanceTimersByTimeAsync(60000); expect(current.subscriptions()).toBe(3);
});

it('replaces a stale stream immediately on foreground wake without replaying bootstrap', async () => {
    const current = await connection('open');
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(1);
    vi.setSystemTime(Date.now() + 5 * 60000);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0);
    expect(current.subscriptions()).toBe(2); expect(current.commands).toEqual(['bootstrap']);
    current.client.retryConnection(); await vi.advanceTimersByTimeAsync(0); expect(current.subscriptions()).toBe(2);
});

it('does not retry each read batch while the event connection is already unavailable', async () => {
    const current = await connection('headers');current.disconnect();await vi.advanceTimersByTimeAsync(0);current.failReads();
    const failed = expect(current.root.files.getNode('/missing')).rejects.toMatchObject({code: 'HTTP_CONNECTION_LOST'});
    await vi.advanceTimersByTimeAsync(0);await failed;
    expect(current.commands.filter(kind => kind === 'queries')).toHaveLength(1);
});

it('waits for a valid event frame before reporting a header-only reconnection as restored', async () => {
    const current = await connection('silent');current.disconnect();await vi.advanceTimersByTimeAsync(0);
    expect(current.subscriptions()).toBe(2);expect(current.disconnected).toHaveBeenCalledOnce();expect(current.reconnected).not.toHaveBeenCalled();
    current.heartbeat();await vi.advanceTimersByTimeAsync(0);expect(current.reconnected).toHaveBeenCalledOnce();
});

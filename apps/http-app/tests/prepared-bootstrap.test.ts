import {afterEach, expect, it, vi} from 'vitest';
import {PreparedHttpBootstrap, SnapshotCache} from '@nestos/app-transport/http/startup';
import {HttpViewClient} from '@nestos/app-transport/http';
import {RpcPeer} from '@nestos/app-transport/application';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
    try {for (const release of cleanup.splice(0).reverse()) await release();}
    finally {vi.useRealTimers();}
});

it('transfers bootstrap before client construction and adopts it once without replay', async () => {
    const server = new RpcPeer('server', async () => ({})); cleanup.push(() => server.close());
    const reply = await server.bootstrap({marker: 'prepared'}), requests: {kind: string; clientId: string}[] = [];
    const fetcher: typeof fetch = vi.fn(async (_url, init) => {
        if (!init?.method) return new Response(new ReadableStream());
        const request = JSON.parse(String(init.body)); requests.push(request);
        return Response.json(request.kind === 'bootstrap' ? reply : {});
    });
    const prepared = new PreparedHttpBootstrap({clientId: 'prepared-client', fetcher});
    cleanup.push(() => prepared.close()); await prepared.packet;
    expect(requests.map(request => request.kind)).toEqual(['bootstrap']);
    const client = new HttpViewClient('prepared-client', '/api/application', fetcher); cleanup.push(() => client.close());
    expect(await client.start({prepared})).toMatchObject({marker: 'prepared'});
    expect(requests.filter(request => request.kind === 'bootstrap')).toHaveLength(1);
    expect(() => prepared.claim('prepared-client', '/api/application', new AbortController().signal)).toThrow('cannot be adopted');
});

it('rejects a foreign client before opening a stream and permits the original owner', async () => {
    const fetcher = vi.fn(async () => Response.json({value: null}));
    const prepared = new PreparedHttpBootstrap({clientId: 'owner', fetcher}); cleanup.push(() => prepared.close());
    await prepared.packet;
    const foreign = new HttpViewClient('foreign', '/api/application', fetcher);
    await expect(foreign.start({prepared})).rejects.toMatchObject({code:'BOOTSTRAP_ADOPTION_INVALID'});
    expect(fetcher).toHaveBeenCalledOnce();
    expect(() => prepared.claim('owner', '/other', new AbortController().signal)).toThrow('cannot be adopted');
});

it('closes an unadopted view once and preserves specific server failures without replay', async () => {
    const kinds: string[] = [];
    const prepared = new PreparedHttpBootstrap({clientId:'failed', fetcher:async (_url, init) => {
        const {kind} = JSON.parse(String(init?.body)); kinds.push(kind);
        return kind === 'bootstrap' ? Response.json({error:{message:'Access denied',code:'FORBIDDEN'}},{status:403}) : Response.json({});
    }});
    await expect(prepared.packet).rejects.toMatchObject({code:'FORBIDDEN'});
    await Promise.all([prepared.close(), prepared.close()]); expect(kinds).toEqual(['bootstrap','close']);
});

it('classifies malformed startup replies without retaining their body', async () => {
    const prepared = new PreparedHttpBootstrap({clientId:'invalid', fetcher:async (_url, init) =>
        JSON.parse(String(init?.body)).kind === 'bootstrap' ? new Response('PRIVATE_INVALID_BODY') : Response.json({})});
    cleanup.push(() => prepared.close());
    await expect(prepared.packet).rejects.toMatchObject({code:'BOOTSTRAP_RESPONSE_INVALID',stage:'decode'});
    await expect(prepared.packet).rejects.not.toThrow('PRIVATE_INVALID_BODY');
});

it('loads existing snapshot identities once and reuses them when the client adopts the reply', async () => {
    const server = new RpcPeer('server', async () => ({})); cleanup.push(() => server.close());
    const reply = await server.bootstrap({marker:'payload '.repeat(300)}), serverCache = new SnapshotCache();
    let stored = '';
    const storage = {read:() => stored, write:(value:string) => {stored = value;}};
    await new SnapshotCache(storage).unpack(await serverCache.pack(reply as any, []));
    const snapshots = new SnapshotCache(storage), load = vi.spyOn(snapshots, 'load');
    let known: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
        if (!init?.method) return new Response(new ReadableStream());
        const request = JSON.parse(String(init.body));
        if (request.kind !== 'bootstrap') return Response.json({});
        known = request.knownSnapshots; return Response.json(await serverCache.pack(reply as any, known));
    };
    const prepared = new PreparedHttpBootstrap({clientId:'warm', fetcher, snapshots}); cleanup.push(() => prepared.close());
    await prepared.packet; expect(known.length).toBeGreaterThan(0);
    const client = new HttpViewClient('warm', '/api/application', fetcher); cleanup.push(() => client.close());
    expect(await client.start({prepared})).toMatchObject({marker:'payload '.repeat(300)});
    expect(load).toHaveBeenCalledOnce();
});

it('does not open a view if cancelled before snapshot loading finishes', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const prepared = new PreparedHttpBootstrap({clientId:'cancel-before-request', fetcher});
    await prepared.close(); await expect(prepared.packet).rejects.toMatchObject({name:'AbortError'});
    expect(fetcher).not.toHaveBeenCalled();
});

it('bounds cleanup of a stalled bootstrap and closes the same identity without replay', async () => {
    vi.useFakeTimers(); const kinds: string[] = [];
    const prepared = new PreparedHttpBootstrap({clientId:'stalled', fetcher:async (_url, init) => {
        const {kind} = JSON.parse(String(init?.body)); kinds.push(kind);
        if (kind === 'close') return Response.json({});
        return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once:true}));
    }});
    await Promise.resolve(); expect(kinds).toEqual(['bootstrap']);
    const closing = prepared.close(); await vi.advanceTimersByTimeAsync(5000); await closing;
    expect(kinds).toEqual(['bootstrap','close']);
});

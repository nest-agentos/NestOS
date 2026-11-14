// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@nestos/app-transport/application';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
    for (const release of cleanup.splice(0).reverse()) await release();
    vi.doUnmock('../src/client/live-connection'); vi.resetModules(); vi.unstubAllGlobals(); sessionStorage.clear();
});

async function blockedClient() {
    let unblock!: () => void;
    const blocked = new Promise<void>(resolve => {unblock = resolve;});
    vi.doMock('../src/client/live-connection', async () => {
        await blocked; return vi.importActual('../src/client/live-connection');
    });
    const server = new RpcPeer('server', async () => ({})); cleanup.push(() => server.close());
    const packet = await server.bootstrap({services:{projects:{}}, marker:'early'}), kinds: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init?: RequestInit) => {
        if (String(_url) === '/api/identity') {kinds.push('identity'); return Response.json({userId:'admin'});}
        if (!init?.method) {kinds.push('events'); return new Response(new ReadableStream());}
        const body = JSON.parse(String(init.body)); kinds.push(body.kind);
        expect(new Headers(init.headers).get('X-NestOS-User')).toBe('admin');
        return Response.json(body.kind === 'bootstrap' ? packet : {});
    }));
    const {connectApplication} = await import('../src/client/application-connection');
    const connection = connectApplication(); void connection.ready.catch(() => {});
    cleanup.push(() => connection.close()); cleanup.push(unblock);
    return {connection, kinds, unblock};
}

it('sends authenticated bootstrap while the RPC module remains blocked', async () => {
    const fixture = await blockedClient();
    await vi.waitFor(() => expect(fixture.kinds).toEqual(['identity','bootstrap']));
    fixture.unblock(); expect(await fixture.connection.ready).toMatchObject({marker:'early'});
    expect(fixture.kinds.filter(kind => kind === 'bootstrap')).toHaveLength(1);
    expect(fixture.kinds.filter(kind => kind === 'events')).toHaveLength(1);
});

it('releases a prepared view when loading is cancelled and never adopts it later', async () => {
    const fixture = await blockedClient();
    await vi.waitFor(() => expect(fixture.kinds).toContain('bootstrap'));
    await fixture.connection.close(); expect(fixture.kinds).toEqual(['identity','bootstrap','close']);
    fixture.unblock(); await expect(fixture.connection.ready).rejects.toMatchObject({name:'AbortError'});
    expect(fixture.kinds).not.toContain('events');
});

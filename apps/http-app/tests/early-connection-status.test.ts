// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {RpcPeer} from '@nestos/app-transport/application';
import {connectApplication} from '../src/client/application-connection';
import {installHttpStatus} from '../src/client/status-banner';
import {t} from '@nestos/common';

const releases: Array<() => unknown> = [];
afterEach(async () => {
    for (const release of releases.splice(0).reverse()) await release();
    document.body.replaceChildren(); sessionStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
async function connection() {
    vi.spyOn(console, 'error').mockImplementation(() => {}); history.replaceState({}, '', '/#/start');
    const server = new RpcPeer('server', async () => ({})); releases.push(() => server.close());
    const bootstrap = await server.bootstrap({backend: {reportClientDiagnostic: async () => {}}, services: {projects: {}}, commands: {execute: async () => {}, list: () => []}});
    let controller!: ReadableStreamDefaultController<Uint8Array>, expired = false;
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
        if (String(_url) === '/api/identity') return Response.json({userId: 'admin'});
        if (!init?.method) return new Response(new ReadableStream<Uint8Array>({start(value) {controller = value;}}));
        if (expired) return Response.json({error: {message: 'Expired'}}, {status: 400, headers: {'X-NestOS-View-Expired': '1'}});
        return Response.json(bootstrap);
    });
    const client = connectApplication(); releases.push(() => client.close()); const root = await client.ready;
    return {client, root: (root as unknown as {commands: {execute(name: string): Promise<void>}}).commands,
        corrupt: () => controller.enqueue(new TextEncoder().encode('data: invalid\n\n')), expire: () => {expired = true;}};
}

it('boots a task from one response, then pins subsequent requests to that response identity',async()=>{
    history.replaceState({},'', '/#/kanban/'+encodeURIComponent('/board/tasks/manager'));
    const host=new RpcPeer('server',async()=>({}));releases.push(()=>host.close());
    const bootstrap=await host.bootstrap({backend:{},services:{projects:{}}});
    const fetcher=vi.fn(async(input:unknown,_init?:RequestInit)=>{
        if(String(input).includes('/events?'))return new Response(new ReadableStream<Uint8Array>(),{headers:{'X-NestOS-View-Resume':'1'}});
        return Response.json(bootstrap,{headers:{'X-NestOS-Authenticated-User':'admin'}});
    });
    vi.stubGlobal('fetch',fetcher);
    const client=connectApplication();releases.push(()=>client.close());
    await client.ready;
    expect(fetcher).toHaveBeenCalledOnce();
    const [route,init]=fetcher.mock.calls[0];
    expect(route).toBe('/api/application');expect(JSON.parse(String(init?.body)).initialRead.task).toEqual({boardId:'tasks',itemId:'manager'});
    expect(new Headers(init?.headers).has('X-NestOS-User')).toBe(false);
    await client.startDeferredEvents!();
    expect(fetcher.mock.calls[1][0]).toMatch(/\/events\?.*&after=0/);
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get('X-NestOS-User')).toBe('admin');
});

it('replays a fatal update error that occurred before the status UI mounted and preserves an unsent draft', async () => {
    const f = await connection(), states: string[] = [];
    const stop = f.client.subscribeStatus(state => states.push(state)); f.corrupt();
    await vi.waitFor(() => expect(states.at(-1)).toBe('view-error')); stop();
    const draft = document.createElement('textarea'); draft.value = 'Unsent draft'; document.body.append(draft);
    const fetcher = vi.fn(), reload = vi.fn(); releases.push(installHttpStatus({connection: f.client, fetcher, reload}));
    expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewError'));
    expect(document.querySelector<HTMLElement>('.http-status')?.hidden).toBe(false);
    expect(fetcher).not.toHaveBeenCalled(); expect(reload).not.toHaveBeenCalled(); expect(draft.value).toBe('Unsent draft');
});

it('replays expiration to a late UI subscriber and checks readiness without repeating the failed operation', async () => {
    const f = await connection(); f.expire();
    await expect(f.root.execute('write')).rejects.toMatchObject({code: 'ECAPABILITY'});
    const fetcher = vi.fn(async () => Response.json({ready: true})), reload = vi.fn();
    releases.push(installHttpStatus({connection: f.client, fetcher, reload}));
    await vi.waitFor(() => expect(document.querySelector('.http-status')?.textContent).toContain(t('httpApp.viewExpiredReady')));
    expect(fetcher).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
});

it('pins the authenticated user and refuses to rebuild an old page for a different certificate user', async () => {
    const f = await connection();
    const fetcher = vi.fn(async () => Response.json({userId: 'alice'})); vi.stubGlobal('fetch', fetcher);
    const other = connectApplication(); releases.push(() => other.close());
    await expect(other.ready).rejects.toThrow('Certificate user changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await f.client.close();
});

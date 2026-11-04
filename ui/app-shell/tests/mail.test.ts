// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {bindApplicationBackend, restrictApplicationFiles} from '@nestos/app-core/host';
import type {LocalApplicationServices} from '@nestos/app-contracts/services';
import {RpcPeer} from '@nestos/app-transport/rpc';
import {CAPABILITIES} from '@nestos/app-transport/application';
import {createMailModule} from '../src/mail';
const createEditor = vi.hoisted(() => vi.fn(async (container: HTMLElement, options: {initialContent: string}) => {
    container.textContent = options.initialContent; return {destroy: async () => {}, getText: () => options.initialContent};
}));
vi.mock('@nestos/mdxeditor', () => ({createMDxEditor: createEditor}));
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks(); createEditor.mockClear();});
it('exposes a scoped mail client through real RPC and keeps list responses free of bodies', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const files = await manager.openFileSystem('/home/admin/emails');
    await files.driver.createFile({parentPath: '/', name: 'test.email', content: 'Subject: RPC mail\nFrom: sender@example.test\n\nprivate-body'});
    const backend = bindApplicationBackend({vfs: manager} as unknown as LocalApplicationServices);
    const local = await backend.mailView(); cleanup.push(() => local.dispose());
    let server!: RpcPeer; const errors = vi.fn(), calls: string[] = [];
    const client = new RpcPeer('client', call => {calls.push(server.query(call) ? 'query' : 'command'); return server.handle(call);}, errors, undefined, undefined, CAPABILITIES);
    server = new RpcPeer('server', call => client.handle(call), errors, undefined, undefined, CAPABILITIES);
    cleanup.push(async () => {await client.close(); await server.close();});
    const initial = await server.bootstrap(local); client.applyUpdates(initial.updates);
    const remote = client.decode(initial.value!) as typeof local;
    const page = await remote.queryMail(); expect(page.total).toBe(1); expect(JSON.stringify(page)).not.toContain('private-body');
    const thread = await remote.readThread({id: page.threads[0].id}); expect(thread.messages[0].body).toBe('private-body');
    await remote.refreshMail(); expect(calls.slice(0, 3)).toEqual(['query', 'query', 'query']); expect(errors).not.toHaveBeenCalled();
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const module = createMailModule({client: remote, sidebar, editor, selected: () => {}, scanners: async () => {}}); cleanup.push(() => module.dispose());
    await module.workbench.start(); expect(createEditor).not.toHaveBeenCalled();
    await module.workbench.openResource('/test.email');
    expect(createEditor).toHaveBeenCalledWith(expect.any(HTMLElement), expect.objectContaining({readOnly: true, contentFormat: 'text', htmlPolicy: 'literal', scrollMode: 'host'}));
    expect(editor.textContent).toContain('private-body');
});
it('shares an index across view leases and keeps other leases usable after one closes', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const files = await manager.openFileSystem('/home/admin/emails'); await files.driver.createFile({parentPath: '/', name: 'a.email', content: 'Subject: A\n\nBody'});
    const backend = bindApplicationBackend({vfs: manager} as unknown as LocalApplicationServices);
    const [first, second] = await Promise.all([backend.mailView(), backend.mailView()]); cleanup.push(() => second.dispose()); cleanup.push(() => first.dispose());
    const read = vi.spyOn(files.driver, 'readContent'); await first.queryMail(); read.mockClear();
    await first.dispose(); expect((await second.queryMail()).total).toBe(1); expect(read).not.toHaveBeenCalled();
});

it('rejects the mail capability when the application view excludes its workspace', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const backend = bindApplicationBackend({vfs: manager} as unknown as LocalApplicationServices);
    const application = {services: {vfs: manager}, backend} as unknown as import('@nestos/app-contracts/services').ApplicationClient;
    const restricted = restrictApplicationFiles(application, ['/home/admin/notes']);
    await expect(restricted.backend.mailView()).rejects.toMatchObject({code: 'EACCES'});
});

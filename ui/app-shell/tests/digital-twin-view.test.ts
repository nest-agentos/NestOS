// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DigitalTwinService} from '@nestos/app-core';
import {TwinWorkbench} from '../src/digital-twin';
import {createPageWindows} from '../src/workspaces/page-windows';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); document.body.replaceChildren(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const service = new DigitalTwinService({fs: await manager.openFileSystem('/'), reader: {sessions: async () => [], read: async spec => ({text: 'Text', hash: 'hash', nativeIdentity: spec.target})},
        extractor: {run: vi.fn(), cleanup: vi.fn(), cancel: vi.fn()}, deleteSession: vi.fn()}); cleanup.push(() => service.dispose());
    for (let index = 0; index < 45; index++) await service.addSource({kind: 'file', target: `file-${index}.md`, label: `Target ${index}`}, 'model');
    const read = vi.spyOn(service, 'readView'), full = vi.spyOn(service, 'snapshot'), connections = vi.fn(async () => []);
    const targets = vi.spyOn(service, 'scannerTargets'), tools = vi.spyOn(service, 'collectionTools');
    const sidebar = document.createElement('aside'), editor = document.createElement('main'); document.body.append(sidebar, editor);
    const pages = createPageWindows({sidebar, editor, title: 'Twin', initialResource: '/overview', initializeAtResource: true, selected() {},
        create: host => new TwinWorkbench({...host, service, connections})}); cleanup.push(() => pages.dispose());
    return {pages, editor, read, full, connections, targets, tools};
}
it('loads a deep page once and avoids scanner configuration/history on overview', async () => {
    const f = await fixture(); await f.pages.workbench.start();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({page: 'overview'}));
    expect(f.full).not.toHaveBeenCalled(); expect(f.connections).not.toHaveBeenCalled(); expect(f.targets).not.toHaveBeenCalled(); expect(f.tools).not.toHaveBeenCalled();
    await f.pages.workbench.openResource('/overview'); expect(f.read).toHaveBeenCalledOnce();
    expect(f.editor.querySelector('.twin [data-form=scanPlan]')).toBeNull();
});
it('reads the next source page and searches beyond the loaded page without changing stored source IDs', async () => {
    const f = await fixture(); await f.pages.workbench.start(); await f.pages.workbench.openResource('/sources/sources');
    const active = () => f.editor.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden])')!;
    const rows = () => active().querySelectorAll('[data-server-page] [data-scan-row]');
    expect(rows()).toHaveLength(20);
    active().querySelector<HTMLButtonElement>('[data-server-page] [data-view-page=next]')!.click();
    await vi.waitFor(() => expect(f.read).toHaveBeenLastCalledWith(expect.objectContaining({offset: 20})));
    await vi.waitFor(() => expect(active().textContent).toContain('Target 39'));
    const input = active().querySelector<HTMLInputElement>('[data-server-page] [data-scan-filter=query]')!;
    input.value = 'Target 44'; input.dispatchEvent(new Event('input', {bubbles: true}));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(active().textContent).toContain('Target 44');
    expect(active().querySelector<HTMLButtonElement>('[data-server-page] [data-view-page=next]')!.disabled).toBe(true);
    expect(active().querySelector<HTMLInputElement>('[data-server-page] [data-scan-filter=query]')!.value).toBe('Target 44');
    expect(f.full).not.toHaveBeenCalled();
});

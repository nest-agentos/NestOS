// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import type {DreamService} from '@nestos/app-contracts/services';
import {DirectoryMountService, ProjectService, SessionFilesService, folderBrowserPath} from '@nestos/app-core';
import {SessionRepository} from '@nestos/llm-session';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import type {VFSUIShell} from '@nestos/vfs-ui';
import {ASSISTANT_ADD_EVENT} from '../src/navigation/assistant-actions';
import {projectDreamResource} from '../src/projects/navigation-policy';
import {createTestWorkbench} from './helpers/application';

it('refreshes a mixed selection and opens the shortcut menu for a projected Dream row', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const root = await manager.openFileSystem('/');
    const repository = new SessionRepository(root); await repository.init();
    const files = new SessionFilesService(root); await files.initialize();
    files.registerSource('admin-home', await manager.openFileSystem('/home/admin'));
    const mounts = new DirectoryMountService(root, files); await mounts.init();
    const projects = new ProjectService(root, repository, mounts, files); await projects.ensureStartup();
    const project = await projects.create('Research'), path = folderBrowserPath(project.path);
    const owner = await projects.openFiles(project.path);
    await owner.fs.driver.createFile({parentPath: '/', name: 'notes.md', content: 'notes'});
    await owner.dispose();
    const sidebar = document.createElement('div'), container = document.createElement('div');
    document.body.append(sidebar, container);
    const shortcut = vi.fn(), events = new AbortController();
    document.addEventListener(ASSISTANT_ADD_EVENT, shortcut, {signal: events.signal});
    const kernel = {onChanged: () => () => {}, async *listSessions() {}};
    const projectDream = {service: {} as DreamService, openSession: vi.fn(), openTask: vi.fn(), openDecision: vi.fn()};
    const workbench = createTestWorkbench({sidebar, container, repository, files, projects, projectDream, onSelect: () => {},
        kernel: kernel as never, directoryMounts: mounts, factory: async () => ({destroy() {}})});
    try {
        await workbench.start();
        const ui = (workbench as unknown as {sidebarUI: VFSUIShell}).sidebarUI;
        const dreamId = projectDreamResource(project.project.id), fileId = path + '/@files/notes.md';
        const dreamRow = `[data-item-id="${dreamId}"]`;
        await ui.expandPath(path);
        await vi.waitFor(() => expect(sidebar.querySelector(`[data-item-id="${path}"] ${dreamRow}`)).not.toBeNull());
        await workbench.openResource(path);
        await ui.expandPath(path + '/@files');
        const menu = () => sidebar.querySelector<HTMLButtonElement>(`${dreamRow} [data-action="item-menu"]`);
        await vi.waitFor(() => expect(menu()).not.toBeNull());
        expect(sidebar.querySelectorAll(dreamRow)).toHaveLength(1);
        expect(ui.allowsBulkAction('delete', [dreamId, fileId])).toBe(false);
        expect(ui.allowsBulkAction('move', [dreamId, fileId])).toBe(false);
        expect(() => ui.refreshList()).not.toThrow();
        expect(ui.allowsBulkAction('copy', [fileId])).toBe(true);
        ui.setSelection([]);
        menu()!.click();
        document.querySelector<HTMLButtonElement>('.vfs-context-menu [data-action="assistant-add-shortcut"]')!.click();
        await vi.waitFor(() => expect(shortcut).toHaveBeenCalledOnce());
        expect(shortcut.mock.calls[0][0].detail.target).toMatchObject({resource: dreamId});
    } finally {
        events.abort();
        await workbench.destroy(); await mounts.dispose(); await files.dispose(); await repository.dispose(); await manager.dispose();
        document.body.replaceChildren();
    }
});

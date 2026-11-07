// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { installMobileViewport } from '../src/navigation/mobile-viewport';
import { setupMobileWorkspaceView } from '../src/navigation/mobile-workspace-view';
import { ACTION_ICONS, t } from '@nestos/common';
import { VFS_DOM_EVENTS } from '@nestos/vfs-ui';
import { WorkbenchTabs } from '../src/workbench/tabs';
import {installMobileShellState} from '../src/navigation/mobile-shell-state';

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('keeps bottom navigation on the kanban catalog and restores it after leaving a board', async () => {
    document.body.innerHTML = '<nav class="app-sidebar"></nav><section class="workspace-view active"><div class="mm-layout"><aside></aside><main></main></div></section>';
    const layout = document.querySelector<HTMLElement>('.mm-layout')!, sidebar = layout.querySelector('aside')!, editor = layout.querySelector('main')!;
    let resource = '/';
    const disposeView = setupMobileWorkspaceView(layout, sidebar, editor, false, () => resource !== '/');
    const disposeShell = installMobileShellState();
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}});
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        const catalog = await tabs.open('/', 'Boards', false);
        catalog.panel.innerHTML = '<section data-editor-mobile-navigation="embedded">Catalog</section>';
        await flush(); expect(layout.dataset.mobileView).toBe('list'); expect(document.body.dataset.mobileNavigation).toBe('standard');
        resource = '/board/example';
        const board = await tabs.open(resource, 'Example', false);
        board.panel.innerHTML = '<section data-editor-mobile-navigation="embedded">Board</section>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail'); expect(document.body.dataset.mobileNavigation).toBe('immersive');
        resource = '/'; tabs.activate('/');
        await flush(); expect(layout.dataset.mobileView).toBe('list'); expect(document.body.dataset.mobileNavigation).toBe('standard');
    } finally {disposeShell(); disposeView(); await tabs.destroy();}
});

it('switches a narrow workspace between the file list and the active editor', async () => {
    const layout = document.createElement('div');
    const sidebar = document.createElement('div');
    const editor = document.createElement('div');
    layout.append(sidebar, editor);
    document.body.append(layout);
    editor.innerHTML = '<div class="mm-placeholder">Choose a file</div>';
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    try {
        expect(layout.dataset.mobileView).toBe('list');
        expect(layout.querySelector('.mm-mobile-back')).toBeNull();
        editor.innerHTML = '<div class="editor">Open file</div>';
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(layout.dataset.mobileView).toBe('detail');
        layout.dataset.mobileView = 'list';
        expect(layout.dataset.mobileView).toBe('list');
        sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated));
        expect(layout.dataset.mobileView).toBe('detail');
    } finally { dispose(); }
});

it('keeps initial tabs in the list and enters detail as soon as a resource is activated', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const tabs = new WorkbenchTabs(editor, { activate: async id => { tabs.activate(id); },
        dispose: async () => {}, empty: () => {}, error: error => { throw error; } });
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        const first = await tabs.open('first', 'First', false);
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        first.panel.innerHTML = '<div class="editor">Ready</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        layout.dataset.mobileView = 'list';
        first.panel.firstElementChild!.append(document.createElement('span'));
        await flush(); expect(layout.dataset.mobileView).toBe('list');
        await tabs.open('second', 'Second', false);
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        tabs.activate('first'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
        first.panel.innerHTML = '<div class="mm-placeholder">Choose a file</div>';
        await flush(); expect(layout.dataset.mobileView).toBe('detail');
        await tabs.close('first'); await tabs.close('second');
        await flush(); expect(layout.dataset.mobileView).toBe('list');
    } finally { dispose(); }
});

it('keeps detail visible during delayed preview disposal and before the next editor mounts', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    let finish!: () => void; const gate = new Promise<void>(resolve => {finish = resolve;});
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => gate, empty() {}, error() {}});
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        const first = await tabs.open('first', 'First'); first.panel.innerHTML = '<div>First conversation</div>';
        await flush(); layout.dataset.mobileView = 'list';
        sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated));
        const states: string[] = [], observer = new MutationObserver(() => {states.push(layout.dataset.mobileView!);});
        observer.observe(layout, {attributes: true, attributeFilter: ['data-mobile-view']});
        const next = tabs.open('second', 'Second'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
        finish(); const second = await next; await flush(); expect(layout.dataset.mobileView).toBe('detail');
        second.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Second conversation</div>';
        await flush(); expect(states).not.toContain('list'); observer.disconnect();
        layout.dataset.mobileView = 'list';
        tabs.activate('second'); await flush(); expect(layout.dataset.mobileView).toBe('detail');
    } finally {finish(); dispose(); await tabs.destroy();}
});

it('opens a deep link directly in detail while restored window entries initialize', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor, true);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}},
        [{id: 'old', title: 'Previous window', pinned: false}]);
    try {
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('detail');
        expect(tabs.current).toBeUndefined();
        await tabs.open('current', 'Current session', false);
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('detail');
    } finally {dispose(); await tabs.destroy();}
});

it('keeps the requested detail presentation while its editor and navigation are still loading', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    layout.dataset.workspaceOpening = 'true';
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor, true);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}},
        [{id: 'old', title: 'Previous window', pinned: false}]);
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        await flush();
        expect(layout.dataset.mobileView).toBe('detail');
        expect(layout.dataset.mobileHeader).toBe('pending');
        const current = await tabs.open('current', 'Current session', false);
        await flush(); expect(layout.dataset.mobileHeader).toBe('pending');
        current.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Current conversation</div>';
        delete layout.dataset.workspaceOpening;
        await flush(); expect(layout.dataset.mobileView).toBe('detail'); expect(layout.dataset.mobileHeader).toBe('embedded');
        layout.dataset.workspaceOpening = 'true'; await flush();
        const next = await tabs.open('document', 'Document', false); next.panel.textContent = 'Document';
        await flush(); expect(layout.dataset.mobileHeader).toBe('pending');
        delete layout.dataset.workspaceOpening;
        await flush(); expect(layout.dataset.mobileView).toBe('detail'); expect(layout.dataset.mobileHeader).toBe('standalone');
    } finally {dispose(); await tabs.destroy();}
});

it('uses embedded navigation only for the active editor and restores standalone navigation for documents', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.append(sidebar, editor); document.body.append(layout);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}});
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    try {
        const chat = await tabs.open('chat', 'Chat', false); chat.panel.innerHTML = '<div data-editor-mobile-navigation="embedded">Chat</div>';
        await flush(); expect(layout.dataset.mobileHeader).toBe('embedded');
        layout.dataset.mobileView = 'list';
        chat.panel.firstElementChild!.append(document.createElement('span')); await flush();
        expect(layout.dataset.mobileView).toBe('list');
        const doc = await tabs.open('doc', 'Document', false); doc.panel.textContent = 'Document';
        await flush(); expect(layout.dataset.mobileHeader).toBe('standalone');
        tabs.activate('chat'); await flush(); expect(layout.dataset.mobileHeader).toBe('embedded');
    } finally { dispose(); await tabs.destroy(); }
});

it('tracks the mobile keyboard viewport, ignores pinch zoom and releases listeners', () => {
    const viewport = Object.assign(new EventTarget(), {height: 800, scale: 1}); let narrow = true;
    vi.stubGlobal('visualViewport', viewport); vi.stubGlobal('matchMedia', () => ({matches: narrow}));
    const dispose = installMobileViewport(), value = () => document.documentElement.style.getPropertyValue('--app-visible-height');
    expect(value()).toBe('800px'); viewport.height = 380; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('380px');
    viewport.scale = 2; viewport.height = 190; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('380px');
    narrow = false; window.dispatchEvent(new Event('resize')); expect(value()).toBe('');
    dispose(); narrow = true; viewport.scale = 1; viewport.dispatchEvent(new Event('resize')); expect(value()).toBe('');
});

it('keeps sidebar and window controls together for standalone documents and preserves the active editor', async () => {
    vi.stubGlobal('matchMedia', () => ({matches:true, addEventListener:vi.fn(),removeEventListener:vi.fn()}));
    history.replaceState(null, '');
    HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
    HTMLDialogElement.prototype.close ??= function () { this.open = false; this.dispatchEvent(new Event('close')); };
    const layout = document.createElement('div'), sidebar = document.createElement('div'), editor = document.createElement('div');
    layout.className = 'mm-layout'; editor.className = 'mm-editor-area'; layout.append(sidebar, editor); document.body.append(layout);
    const tabs = new WorkbenchTabs(editor, {activate: async id => tabs.activate(id), dispose: async () => {}, empty() {}, error() {}});
    sidebar.append(tabs.opened);
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor);
    try {
        const doc = await tabs.open('doc', 'Document', false); doc.panel.innerHTML = '<textarea>Unsaved content</textarea>';
        tabs.context('doc', 'Personal');
        await new Promise(resolve => setTimeout(resolve, 0));
        const navigation = editor.querySelector('.workbench-tabs__navigation .workbench-compact-navigation')!;
        const buttons = navigation.querySelectorAll<HTMLButtonElement>('button');
        expect(layout.dataset.mobileHeader).toBe('standalone');
        const icon = document.createElement('div'); icon.innerHTML = ACTION_ICONS.back;
        expect(buttons[0].firstElementChild!.isEqualNode(icon.firstElementChild)).toBe(true); expect(buttons[0].getAttribute('aria-label')).toBe(t('workspace.mobile.back'));
        const opened = navigation.querySelector<HTMLButtonElement>('.workbench-window-list')!;
        icon.innerHTML = ACTION_ICONS.opened; expect(opened.firstElementChild!.isEqualNode(icon.firstElementChild)).toBe(true); expect(navigation.textContent).toContain('Document'); expect(navigation.textContent).toContain('Personal');
        opened.click(); const dialog = document.querySelector<HTMLDialogElement>('.workbench-opened-sheet')!;
        expect(dialog.open).toBe(true); expect(dialog.contains(tabs.opened)).toBe(true); dialog.close();
        buttons[0].click(); expect(layout.dataset.mobileView).toBe('list');
        expect(doc.panel.querySelector('textarea')!.value).toBe('Unsaved content');
        tabs.activate('doc'); await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('detail');
    } finally { dispose(); await tabs.destroy(); }
});

it('uses an explicit content state so an empty mail reader does not hide the mobile sidebar', async () => {
    const layout = document.createElement('div'), sidebar = document.createElement('aside'), editor = document.createElement('main');
    layout.append(sidebar, editor); document.body.append(layout); editor.innerHTML = '<p class="mail__empty">Choose a thread</p>';
    let active = false;
    const dispose = setupMobileWorkspaceView(layout, sidebar, editor, false, () => active);
    try {
        expect(layout.dataset.mobileView).toBe('list');
        editor.innerHTML = '<section class="mail__thread"><header data-editor-mobile-navigation="embedded">Thread</header></section>';
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('list');
        active = true; sidebar.dispatchEvent(new CustomEvent(VFS_DOM_EVENTS.resourceActivated, {bubbles: true}));
        expect(layout.dataset.mobileView).toBe('detail');
        editor.append(document.createElement('p')); await new Promise(resolve => setTimeout(resolve, 0));
        expect(layout.dataset.mobileHeader).toBe('embedded');
        layout.dataset.mobileView = 'list'; editor.append(document.createElement('p'));
        await new Promise(resolve => setTimeout(resolve, 0)); expect(layout.dataset.mobileView).toBe('list');
    } finally {dispose();}
});

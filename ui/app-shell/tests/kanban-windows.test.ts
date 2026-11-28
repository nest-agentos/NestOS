// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {createNestOSKanban} from '@nestos/app-core/kanban';
import {SeqKanbanStore} from '@nestos/kanban/storage';
import {KanbanWindowWorkbench} from '../src/kanban/windows';
import {WorkbenchWindows} from '../src/workbench/windows';
import {t} from '@nestos/common';
import {kanbanReference} from '@nestos/kanban/contracts';
import {UserEventService} from '../../../backend/app-core/src/events/service';
import {ShellApplicationEvents} from '../src/lifecycle/application-events';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); document.body.replaceChildren();});
async function fixture(initialResource = '/board/b/card', shared?: {service: ReturnType<typeof createNestOSKanban>; events: UserEventService},
    bookmarks?: ConstructorParameters<typeof WorkbenchWindows>[1]) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const store = await SeqKanbanStore.open(await manager.openFileSystem('/'));
    const events = shared?.events ?? await UserEventService.open(await manager.openFileSystem('/'));
    if (!shared) closes.push(async () => {events.journal.close();});
    const service = shared?.service ?? createNestOSKanban({store, actor: {kind: 'human', id: 'admin'}, authorize: async () => {}, log: vi.fn(),
        notifications: {sourceId:'test:personal',journal:events.journal}});
    if (!shared) {
    const board = await service.create({id: 'b', title: 'Board', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Work',roles:['coordinator','worker']}]});
    await service.execute(board.id,{operationId:'management',expectedRevision:board.revision,command:{type:'create-item',item:{id:'management-root',title:'Manage',responsibility:'Coordinate',acceptance:'Accepted children'}}});
    await service.execute(board.id, {operationId: 'create', expectedRevision: board.revision+1, command: {type: 'create-item', item: {id: 'card', title: 'A long item title', responsibility: 'Work', acceptance: 'Done'},planning:{kind:'task',parentId:'management-root',priority:2,dependencies:[],references:[]}}});
    }
    const editor = document.createElement('main'), sidebar = document.createElement('aside'); document.body.append(sidebar, editor);
    const registry = new WorkbenchWindows(undefined, bookmarks), selected = vi.fn(), openSession = vi.fn(async () => {}), queries = vi.spyOn(service, 'queryActivity'); let workbench!: KanbanWindowWorkbench;
    workbench = new KanbanWindowWorkbench({service, sidebar, editor, initialResource, selected, openSession,
        windows: {registry, id: 'kanban', isActive: () => true, navigate: path => workbench.openResource(path)}});
    closes.push(() => workbench.destroy()); await workbench.start();
    const active = () => editor.querySelector<HTMLElement>('.workbench-tabs__panel:not([hidden]) > .kanban')!;
    return {editor, sidebar, registry, workbench, active, service, events, selected, queries, openSession};
}
async function subscribe(f: Awaited<ReturnType<typeof fixture>>) {
    const feed = new ShellApplicationEvents(f.events,() => f.workbench.invalidateFromEvents(),() => true);
    closes.push(async () => {feed.close();}); await feed.prepare(); await feed.start();
}
async function deleteBoard(f: Awaited<ReturnType<typeof fixture>>) {
    await f.service.execute('b',{operationId:'delete-b',expectedRevision:(await f.service.read('b')).revision,command:{type:'delete-board'}});
}
async function idle(active: () => HTMLElement) {await vi.waitFor(() => expect(active().hasAttribute('aria-busy')).toBe(false));}
const boardLogs = '/board/b/@log';
async function openLogDraft(active: () => HTMLElement) {
    active().querySelector<HTMLButtonElement>('[data-action=new-log]')!.click();
    await vi.waitFor(() => expect(active().querySelector('form[data-form=record]')).not.toBeNull());
    await idle(active);
    return active();
}
it('pins a decision page from More and only reads saved pages when another device opens its window list', async () => {
    HTMLDialogElement.prototype.showModal ??= function () {this.open = true;};
    HTMLDialogElement.prototype.close ??= function () {this.open = false; this.dispatchEvent(new Event('close'));};
    const path = '/board/b/@decision';
    const saved = {workspace: 'kanban', resource: path, title: 'Decisions'};
    const set = vi.fn(async () => {}), list = vi.fn(async () => [saved]);
    const first = await fixture(path, undefined, {set, list, navigate: vi.fn()});
    const pin = first.active().querySelector<HTMLButtonElement>('.kanban__page-header .workbench-menu-pin')!;
    expect(pin.getAttribute('aria-pressed')).toBe('false'); pin.click();
    await vi.waitFor(() => expect(pin.getAttribute('aria-pressed')).toBe('true'));
    expect(set).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({pinned: true, window: expect.objectContaining({resource: path})}));
    let open: (resource: string) => Promise<void>;
    const navigate = vi.fn(async (window: typeof saved) => open(window.resource));
    const second = await fixture('/board/b', first, {set, list, navigate});
    open = resource => second.workbench.openResource(resource);
    expect(list).not.toHaveBeenCalled();
    second.active().querySelector<HTMLButtonElement>('.kanban__page-header .workbench-window-list')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-opened-pin]')).not.toBeNull());
    expect(list).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-opened-pin] .workbench-tabs__opened-label')!.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith(saved));
    await vi.waitFor(() => expect(second.workbench.getActiveResourceId()).toBe(path));
    await vi.waitFor(() => expect(document.querySelector('.workbench-opened-sheet[open]')).toBeNull());
});
it('reuses the current window when navigating item, board and catalog through the common header', async () => {
    const f = await fixture();
    const view = f.active();
    await f.workbench.openResource('/board/b/card'); expect(f.queries).not.toHaveBeenCalled();
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/card']);
    expect(f.sidebar.querySelector('.vfs-window-management')).not.toBeNull();
    expect(f.active().querySelector('[data-panel] .kanban__panel-header .workbench-window-list')).not.toBeNull();
    f.active().querySelector<HTMLButtonElement>('[data-panel] [data-window-navigation=parent]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/board/b')); await idle(f.active);
    expect(f.active().querySelector('.kanban__page-header .workbench-window-list')).not.toBeNull();
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b']);
    f.active().querySelector<HTMLButtonElement>('.kanban__page-header [data-window-navigation=parent]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/')); await idle(f.active);
    expect(f.active().querySelector<HTMLButtonElement>('[data-window-navigation=parent]')!.hidden).toBe(true);
    expect(f.registry.items().map(item => item.id)).toEqual(['/']);
    await f.workbench.openResource('/board/b/card');
    expect(f.active()).toBe(view);
    const board = await f.service.read('b'), {item} = await f.service.item('b', 'card');
    expect(f.active().querySelector('[data-panel] h3')?.textContent).toBe(kanbanReference(board, item) + item.title);
    expect(f.active().querySelector('[data-panel] h3 [data-entity-type=execution] svg')).not.toBeNull();
});

it('loads explicitly opened sibling tabs from the shared catalog without redundant reads', async () => {
    const f = await fixture('/board/b');
    const catalog = vi.spyOn(f.service,'catalog'), principal = vi.spyOn(f.service,'currentPrincipal'), records = vi.spyOn(f.service,'records');
    await f.workbench.openResource('/board/b/@log', {newTab: true}); await f.workbench.openResource('/board/b/@decision', {newTab: true});
    expect(catalog).not.toHaveBeenCalled(); expect(principal).not.toHaveBeenCalled(); expect(records).toHaveBeenCalledTimes(2);
    await f.workbench.openResource('/board/b/@log');
    expect(records).toHaveBeenCalledTimes(2);
});
it('keeps filter, scroll and unsaved forms when switching windows and refuses to close unsaved work', async () => {
    const f = await fixture('/board/b');
    const boardElement = f.active(), form = boardElement.querySelector<HTMLFormElement>('[data-form=filter]')!;
    form.querySelector<HTMLInputElement>('[name=search]')!.value = 'A long';
    form.dispatchEvent(new Event('submit', {bubbles: true, cancelable: true})); await idle(f.active);
    const column = boardElement.querySelector<HTMLElement>('[data-column=backlog]')!; column.scrollTop = 123;
    await f.workbench.openResource('/board/b/card', {newTab: true}); await f.workbench.openResource('/board/b');
    expect(f.active()).toBe(boardElement); expect(column.scrollTop).toBe(123);
    expect(boardElement.querySelector<HTMLInputElement>('[name=search]')!.value).toBe('A long');
    await f.workbench.openResource(boardLogs, {newTab: true});
    const draft = await openLogDraft(f.active);
    const title = draft.querySelector<HTMLInputElement>('[name=title]')!; title.value = 'Unsaved'; title.dispatchEvent(new Event('input', {bubbles: true}));
    await expect(f.workbench.openResource('/board/b/@decision')).rejects.toThrow(t('kanban.unsaved'));
    await f.workbench.openResource('/board/b/card'); await f.workbench.openResource(boardLogs);
    expect(draft.querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Unsaved');
    expect(f.registry.items().find(item => item.id === boardLogs)!.dirty).toBe(true);
    await expect(f.registry.items().find(item => item.id === boardLogs)!.close()).rejects.toThrow(t('kanban.unsaved'));
    draft.querySelector<HTMLButtonElement>('[data-panel] [data-action=close-panel]')!.click(); await idle(f.active);
    await f.registry.items().find(item => item.id === boardLogs)!.close();
    expect(f.registry.items().map(item => item.id)).toEqual(expect.arrayContaining(['/board/b', '/board/b/card']));
    expect(f.registry.items().some(item => item.id === boardLogs)).toBe(false);
});
it('marks hidden windows dirty without querying them until activated, and unregisters all window metadata', async () => {
    const f = await fixture('/board/b'); await f.workbench.openResource('/board/b/card', {newTab: true});
    f.workbench.setVisible(false); const query = vi.spyOn(f.service, 'query');
    f.workbench.invalidateFromEvents(); expect(query).not.toHaveBeenCalled();
    f.workbench.setVisible(true); await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1)); await idle(f.active);
    await f.workbench.destroy(); expect(f.registry.items()).toHaveLength(0);
});

it('keeps one VFS sidebar while switching and closing editors, including a dirty inspector', async () => {
    const f = await fixture(boardLogs);
    const list = f.sidebar.querySelector('.vfs-node-list')!; expect(list).not.toBeNull();
    expect(f.sidebar.querySelector('.kanban__sidebar')).toBeNull(); expect(f.sidebar.textContent).toContain('Board');
    await openLogDraft(f.active);
    const field = f.active().querySelector<HTMLInputElement>('[name=title]')!; field.value = 'Draft'; field.dispatchEvent(new Event('input', {bubbles: true}));
    expect(f.sidebar.inert).not.toBe(true);
    await f.workbench.openResource('/board/b/card', {newTab: true}); await f.workbench.openResource('/');
    expect(f.sidebar.querySelectorAll('.vfs-node-list')).toHaveLength(1); expect(f.sidebar.querySelector('.vfs-node-list')).toBe(list);
    await f.workbench.openResource(boardLogs); expect(f.active().querySelector<HTMLInputElement>('[name=title]')!.value).toBe('Draft');
    f.active().querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click(); await idle(f.active);
    await f.registry.items().find(item => item.id === boardLogs)!.close(); expect(f.sidebar.textContent).toContain('Board');
});
it('updates shared navigation after creating a board through its toolbar', async () => {
    const f = await fixture('/');
    f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.newBoard') + '"]')!.click();
    await vi.waitFor(() => expect(f.active().querySelector('[data-form=board]')).not.toBeNull()); await idle(f.active);
    const id = f.active().querySelector<HTMLInputElement>('[data-form=board] [name=id]')!; id.value = 'new-board'; id.dispatchEvent(new Event('input', {bubbles: true}));
    const input = f.active().querySelector<HTMLInputElement>('[name=title]')!; input.value = 'New board'; input.dispatchEvent(new Event('input', {bubbles: true}));
    f.active().querySelector<HTMLButtonElement>('[data-form=board] button:not([type])')!.click(); await idle(f.active);
    await vi.waitFor(() => expect(f.sidebar.textContent).toContain('New board'));
    expect(f.sidebar.querySelectorAll('.vfs-node-list')).toHaveLength(1); expect(f.sidebar.textContent).toContain('Board');
});

it('keeps search, create and refresh in the shared browser header without a reference lookup', async () => {
    const f = await fixture('/');
    const search = f.sidebar.querySelector<HTMLInputElement>('input[type=search]')!;
    const create = f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.newBoard') + '"]')!;
    const refresh = f.sidebar.querySelector<HTMLButtonElement>('button[aria-label="' + t('kanban.refresh') + '"]')!;
    expect(search.closest('.vfs-node-list__header')?.contains(create)).toBe(true);
    expect(search.closest('.vfs-node-list__header')?.contains(refresh)).toBe(true);
    expect(create.closest('details')).toBeNull(); expect(refresh.closest('details')).toBeNull();
    expect(f.sidebar.querySelector('button[aria-label="' + t('kanban.openReference') + '"]')).toBeNull();
});

it('keeps a recurring management deep link open while hiding its run board from the sidebar',async()=>{
    const first=await fixture('/@loops'),id='run-recurring';
    const board=await first.service.create({id,title:'Private round',scope:{kind:'collection',namespace:'recurring-run',id:'round'},
        members:[{kind:'human',id:'admin',responsibility:'Coordinate',roles:['coordinator']}]});
    await first.service.execute(id,{operationId:'make-manager',expectedRevision:board.revision,command:{type:'create-item',
        item:{id:'manager',title:'Recurring manager',responsibility:'Coordinate',acceptance:'Done'}}});
    const path='/board/'+id+'/manager';
    const direct=await fixture(path,first);
    first.workbench.invalidateFromEvents();
    await first.workbench.openResource(path);
    for(const f of [first,direct]){
        await vi.waitFor(()=>{
            expect(f.sidebar.querySelector('.vfs-node-list [data-item-id="/board/'+id+'"]')).toBeNull();
            expect(f.active().querySelector('[data-panel]')?.textContent).toContain('Recurring manager');
        });
        expect(f.workbench.getActiveResourceId()).toBe(path);
    }
});

it('refreshes both sidebars and retires clean board and item tabs through the shared event feed',async () => {
    const first = await fixture('/board/b'), second = await fixture('/board/b/card',first);
    await first.workbench.openResource('/board/b/card', {newTab: true}); await subscribe(first); await subscribe(second);
    await deleteBoard(first);
    await vi.waitFor(() => {
        for (const f of [first,second]) {
            expect(f.workbench.getActiveResourceId()).toBe('/');
            expect(f.registry.items().some(item => item.id.startsWith('/board/b'))).toBe(false);
            expect(f.sidebar.textContent).not.toContain('Board');
            expect(f.active().textContent).not.toContain('BOARD_NOT_FOUND');
        }
    });
});

it('preserves a deleted board draft, blocks submission and keeps it when returning to the catalog',async () => {
    const f = await fixture(boardLogs); await subscribe(f);
    const draft = await openLogDraft(f.active), title = draft.querySelector<HTMLInputElement>('[name=title]')!;
    title.value = 'Keep this draft'; title.dispatchEvent(new Event('input',{bubbles:true}));
    await deleteBoard(f); const execute = vi.spyOn(f.service,'execute');
    await vi.waitFor(() => expect(draft.querySelector('[data-resource-unavailable]')).not.toBeNull());
    expect(title.value).toBe('Keep this draft'); expect(f.registry.items().find(item => item.id === boardLogs)?.dirty).toBe(true);
    draft.querySelector('form[data-form=record]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await idle(f.active);
    expect(execute).not.toHaveBeenCalled();
    draft.querySelector<HTMLButtonElement>('[data-action=unavailable-return]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/'));
    await vi.waitFor(() => expect(draft.hasAttribute('aria-busy')).toBe(false));
    expect(title.value).toBe('Keep this draft'); expect(f.registry.items().find(item => item.id === boardLogs)?.dirty).toBe(true);
    await f.workbench.openResource(boardLogs);
    expect(title.value).toBe('Keep this draft');
    draft.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();
    await vi.waitFor(() => expect(f.registry.items().find(item => item.id === boardLogs)?.dirty).not.toBe(true));
    await vi.waitFor(() => expect(f.registry.items().some(item => item.id === boardLogs)).toBe(false));
});

it('does not retire a board when the catalog refresh fails',async () => {
    const f = await fixture('/board/b'), catalog = vi.spyOn(f.service,'catalog').mockRejectedValue(Object.assign(new Error('private'),{code:'EIO'}));
    f.workbench.invalidateFromEvents();
    await vi.waitFor(() => expect(f.sidebar.querySelector('[role=alert]')!.textContent).toBe(t('kanban.errors.EIO')));
    expect(f.workbench.getActiveResourceId()).toBe('/board/b'); expect(f.sidebar.textContent).toContain('Board');
    expect(f.active().querySelector('[data-resource-unavailable]')).toBeNull();
    catalog.mockRestore();
});

it('waits for an in-flight submission to settle before retiring the deleted board',async () => {
    const f = await fixture(boardLogs); await subscribe(f);
    const draft = await openLogDraft(f.active);
    for (const [name,value] of Object.entries({title:'Committed before deletion',content:'Work completed'})) {
        const input = draft.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name=${name}]`)!; input.value = value; input.dispatchEvent(new Event('input',{bubbles:true}));
    }
    let release!: () => void, committed = false;
    const held = new Promise<void>(resolve => {release = resolve;}), execute = f.service.execute.bind(f.service);
    vi.spyOn(f.service,'execute').mockImplementationOnce(async (...args) => {const result = await execute(...args); committed = true; await held; return result;});
    draft.querySelector('[data-form=record]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    try {
        await vi.waitFor(() => expect(committed).toBe(true)); await deleteBoard(f);
        await vi.waitFor(() => expect(f.sidebar.querySelector('.vfs-node-list')!.textContent).not.toContain('Board'));
        expect(draft.hasAttribute('aria-busy')).toBe(true); expect(f.registry.items().some(item => item.id === boardLogs)).toBe(true);
    } finally {release();}
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/'));
    expect(f.registry.items().some(item => item.id.startsWith('/board/b'))).toBe(false);
});

it('keeps project decision shortcuts alive through catalog refresh and opens the selected board with the same project',async()=>{
 const {projectDecisionsPath}=await import('../src/kanban/links');
 const f=await fixture();
 await f.service.create({id:'another',title:'Another',scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Review'}]});
 const reference={system:'nestos-remote-project',id:'secondary'};
 Object.assign(f.service,{recordResources:async()=>[{reference,label:'Secondary',group:'cell'}]});
 await f.workbench.openResource(projectDecisionsPath('secondary'));expect(f.workbench.getActiveResourceId()).toBe(projectDecisionsPath('secondary'));
 f.workbench.invalidateFromEvents();await vi.waitFor(()=>expect(f.active().querySelector('[data-board=b]')).not.toBeNull());
 f.active().querySelector<HTMLButtonElement>('[data-board=b]')!.click();
 await vi.waitFor(()=>expect(f.workbench.getActiveResourceId()).toBe('/board/b/@decision/nestos-remote-project/secondary'));
 await vi.waitFor(()=>expect(f.active().querySelector<HTMLInputElement>('.kanban__filter-checklist input:checked')?.value).toBe(JSON.stringify(reference)));
 Object.assign(f.service,{startRecordConversation:vi.fn()});
 f.active().querySelector<HTMLButtonElement>('[data-action=new-decision]')!.click();
 await vi.waitFor(()=>expect(f.active().querySelector('[name=primaryResource]')).not.toBeNull());
 f.active().querySelector<HTMLButtonElement>('[data-panel] [data-action=close-panel]')!.click();
 await vi.waitFor(()=>expect(f.active().querySelector<HTMLElement>('[data-panel]')!.hidden).toBe(true));
 expect(f.workbench.getActiveResourceId()).toBe('/board/b/@decision/nestos-remote-project/secondary');
});

it('opens the same execution and harness settings from the board menu and sidebar and saves only the selected board',async()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.open=false;this.dispatchEvent(new Event('close'));}});
 const f=await fixture();await f.service.create({id:'other',title:'Other',scope:{kind:'system'},members:(await f.service.read('b')).members});
 Object.assign(f.service,{boardSettings:vi.fn(async()=>({fields:[{name:'target',label:'Harness',choices:[{value:'',label:'Default'},{value:'codex',label:'Codex'},{value:'claude',label:'Claude'}]}]}))});
 await f.workbench.openResource('/board/b');f.active().querySelector<HTMLButtonElement>('[data-action=board-settings]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('[data-board-settings=b]')).not.toBeNull());
 const dialog=document.querySelector<HTMLDialogElement>('dialog.kanban-sidebar-controls')!;
 expect(dialog.textContent).toContain(t('kanban.boardControl.execution'));expect(dialog.textContent).toContain(t('kanban.executionSlots'));
 expect(dialog.querySelector<HTMLSelectElement>('[data-settings-scope]')!.value).toBe('b');
 dialog.querySelector<HTMLSelectElement>('[name=setting-target]')!.value='codex';
 dialog.querySelector<HTMLInputElement>('[name=executionSlots]')!.value='5';
 dialog.querySelector<HTMLInputElement>('[name=executionSlotsPerAssignee]')!.value='3';
 dialog.querySelector<HTMLButtonElement>('[data-board-control=manual]')!.click();
 await vi.waitFor(()=>expect(dialog.querySelector<HTMLButtonElement>('[data-board-control=manual]')!.disabled).toBe(false));
 expect((await f.service.read('b')).executionControl?.mode).toBe('manual');
 dialog.querySelector<HTMLFormElement>('form')!.requestSubmit();
 await vi.waitFor(()=>expect(document.querySelector('dialog.kanban-sidebar-controls')).toBeNull());
 expect((await f.service.read('b')).settings).toEqual({target:'codex'});expect((await f.service.read('other')).settings).toBeUndefined();
 expect((await f.service.read('b')).policy).toMatchObject({maxInProgress:5,maxInProgressPerAssignee:3});
 f.sidebar.querySelector<HTMLButtonElement>('[data-action=execution-settings]')!.click();
 await vi.waitFor(()=>expect(document.querySelector('[data-board-settings=b]')).not.toBeNull());
 expect(document.querySelector<HTMLSelectElement>('[name=setting-target]')!.value).toBe('codex');
 expect(document.querySelectorAll('dialog.kanban-sidebar-controls')).toHaveLength(1);
});


it('defaults the Kanban entry to decisions and keeps an explicit task board accessible', async () => {
    const f = await fixture('/');
    expect(f.workbench.getActiveResourceId()).toBe('/board/b/@decision');
    expect(f.active().querySelector('.kanban__decision-table')).not.toBeNull();
    expect(f.queries).not.toHaveBeenCalled();
    await f.workbench.openResource('/board/b');
    expect(f.active().querySelector('[data-context=board]')?.getAttribute('aria-current')).toBe('page');
});

it('keeps the catalog for multiple boards and opens its selection on decisions', async () => {
    const seed = await fixture('/board/b');
    await seed.service.create({id: 'second', title: 'Second', scope: {kind: 'system'}, members: [{kind: 'human', id: 'admin', responsibility: 'Work', roles: ['coordinator', 'worker']}]});
    const f = await fixture('/', seed);
    const view = f.active();
    expect(f.workbench.getActiveResourceId()).toBe('/');
    f.active().querySelector<HTMLButtonElement>('[data-board=b]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/board/b/@decision'));
    await idle(f.active); expect(f.active().querySelector('.kanban__decision-table')).not.toBeNull();
    expect(f.active()).toBe(view);
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/@decision']);
});

it('opens a decision in the same page and delegates its session link separately', async () => {
    const f = await fixture('/board/b/@decision');
    const board = await f.service.read('b');
    await f.service.execute('b', {operationId: 'new-decision', expectedRevision: board.revision, command: {
        type: 'append-record', record: {id: 'd', kind: 'decision', title: 'Decision', content: 'Scope', rationale: 'Evidence', itemIds: [], sources: []},
    }});
    f.workbench.invalidateFromEvents();
    const view = f.active();
    await vi.waitFor(() => expect(view.querySelector('button[data-record=d]')).not.toBeNull()); await idle(f.active);
    view.querySelector<HTMLButtonElement>('button[data-record=d]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/board/b/@record/d')); await idle(f.active);
    expect(f.active()).toBe(view);
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/@record/d']);
    const link = document.createElement('a'); link.href = '#'; link.dataset.session = 'linked-session'; view.append(link); link.click();
    await vi.waitFor(() => expect(f.openSession).toHaveBeenCalledExactlyOnceWith('linked-session'));
    expect(f.workbench.getActiveResourceId()).toBe('/board/b/@record/d');
});

it('keeps one tab for task card clicks and subsequent workspace route changes', async () => {
    const f = await fixture('/board/b'), view = f.active();
    view.querySelector<HTMLButtonElement>('button[data-item=card]')!.click();
    await vi.waitFor(() => expect(f.workbench.getActiveResourceId()).toBe('/board/b/card'));
    await idle(f.active);
    expect(f.active()).toBe(view);
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/card']);
    await f.workbench.openResource('/board/b');
    await f.workbench.openResource('/board/b/@decision');
    expect(f.active()).toBe(view);
    expect(f.registry.items().map(item => item.id)).toEqual(['/board/b/@decision']);
    expect(f.openSession).not.toHaveBeenCalled();
});

it.each(['/board/b/card', '/board/b/@decision'])('uses the initial page when the workspace router opens %s', async path => {
    const f = await fixture('/board/b'), view = f.active();
    await f.workbench.openResource(path);
    await idle(f.active);
    expect(f.active()).toBe(view);
    expect(f.registry.items().map(item => item.id)).toEqual([path]);
});

it('rereads failed Session observations after HTTP reconnect and removes its recovery listener on close',async()=>{
 const f=await fixture(),read=vi.spyOn(f.service,'executionSession');
 read.mockRejectedValueOnce(Object.assign(new Error('Application connection interrupted'),{code:'HTTP_CONNECTION_LOST'}));
 f.workbench.invalidateFromEvents();
 await vi.waitFor(()=>expect(f.active().querySelector('[data-read-stage="ui.item.session"]')).not.toBeNull());
 read.mockResolvedValue({current:{sessionId:'original',state:'completed',stale:false,recent:false,observedAt:Date.now()},history:[]} as never);
 const before=read.mock.calls.length;window.dispatchEvent(new Event('nestos:http-reconnected'));
 await vi.waitFor(()=>expect(read.mock.calls.length).toBeGreaterThan(before));
 await vi.waitFor(()=>expect(f.active().querySelector('[data-read-stage="ui.item.session"]')).toBeNull());
 expect(f.active().querySelector('[data-execution-state=completed]')?.getAttribute('data-stale')).toBe('false');
 await f.workbench.destroy();const closed=read.mock.calls.length;window.dispatchEvent(new Event('nestos:http-reconnected'));
 await Promise.resolve();expect(read.mock.calls.length).toBe(closed);
});
it('keeps another board event from refreshing the current body and still reloads it for its own board',async()=>{
 const f=await fixture('/board/b');await idle(f.active);f.queries.mockClear();
 f.workbench.invalidateFromEvents({resourceId:'kanban:'+JSON.stringify(['test:personal','other',null])} as never);
 await Promise.resolve();await Promise.resolve();expect(f.queries).not.toHaveBeenCalled();
 f.workbench.invalidateFromEvents({resourceId:'kanban:'+JSON.stringify(['test:personal','b',null])} as never);
 await vi.waitFor(()=>expect(f.queries).toHaveBeenCalledOnce());
});

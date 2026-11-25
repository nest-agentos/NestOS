// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {KanbanSidebarControls} from '../src/kanban/sidebar-controls';
import {t} from '@nestos/common';
import type {KanbanBoardSummary, KanbanClient} from '@nestos/kanban/contracts';
import {KanbanSidebar} from '../src/kanban/sidebar';

const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(close => close()); document.body.replaceChildren();});
const board = (id: string): KanbanBoardSummary => ({id, title: id, number: 1, items: [], policy: {}} as unknown as KanbanBoardSummary);
async function fixture() {
    const catalog = vi.fn(async () => [board('Initial')]), report = vi.fn(), navigate = vi.fn(async () => {}), catalogChanged = vi.fn();
    const records = vi.fn(async () => ({items: [{id:'formal', title:'Recurring formal', recurrence:{}}, {id:'once', title:'One shot'}]}));
    const recordConversations = vi.fn(async () => [
        {id:'draft', title:'Recurring draft', resourceId:'/native/draft', recurrence:{}},
        {id:'confirmed', title:'Duplicate', recordId:'formal', recurrence:{}},
    ]);
    const createDecision = vi.fn(async () => {}), openDream = vi.fn(async () => {});
    const container = document.createElement('aside'); document.body.append(container);
    const sidebar = new KanbanSidebar({container, service: {catalog, records, recordConversations, startRecordConversation: vi.fn()} as unknown as KanbanClient, navigate, create: vi.fn(), createDecision, openDream, report, catalogChanged});
    cleanups.push(() => sidebar.destroy()); await sidebar.start();
    return {sidebar, container, catalog, report, navigate, catalogChanged, records, createDecision, openDream};
}
it('opens Dream from the fixed sidebar action', async () => {
    const f = await fixture();
    const action = f.container.querySelector<HTMLElement>('[data-action="dream"]');
    expect(action).not.toBeNull(); action!.click();
    await vi.waitFor(() => expect(f.openDream).toHaveBeenCalledOnce());
});
it('opens the default loop board as a single sidebar item', async () => {
    const f = await fixture();
    expect(f.container.querySelector('[data-action="toggle-folder"]')).toBeNull();
    expect(f.records).not.toHaveBeenCalled();
    const item = f.container.querySelector<HTMLElement>('[data-item-id="/@loops"]')!;
    expect(item.textContent).toContain(t('kanban.loops'));
    item.querySelector<HTMLElement>('[title]')!.click();
    await vi.waitFor(() => expect(f.navigate).toHaveBeenCalledWith('/@loops'));
    expect(f.records).not.toHaveBeenCalled();
});
it('offers new decision in the board item menu', async () => {
    const f = await fixture();
    f.container.querySelector<HTMLElement>('[data-item-id="/board/Initial"] [data-action="item-menu"]')!.click();
    const action = '.vfs-context-menu [data-action="create-decision"]';
    await vi.waitFor(() => expect(document.querySelector(action)?.textContent).toContain(t('kanban.createDecision')));
    expect(document.querySelector('.vfs-context-menu [data-action="create-loop"]')).toBeNull();
    document.querySelector<HTMLElement>(action)!.click();
    await vi.waitFor(() => expect(f.createDecision).toHaveBeenCalledWith('Initial', false));
});
it('starts recurring creation from the loop board menu', async () => {
    const f = await fixture();
    f.container.querySelector<HTMLElement>('[data-item-id="/@loops"] [data-action="item-menu"]')!.click();
    const action = '.vfs-context-menu [data-action="create-loop"]';
    await vi.waitFor(() => expect(document.querySelector(action)).not.toBeNull());
    expect(document.querySelector('.vfs-context-menu [data-action="create-decision"]')).toBeNull();
    document.querySelector<HTMLElement>(action)!.click();
    await vi.waitFor(() => expect(f.createDecision).toHaveBeenCalledWith('Initial', true));
    expect(f.records).not.toHaveBeenCalled();
});
it('does not reconcile windows against a catalog response invalidated while it was loading',async () => {
    const f = await fixture(); let finish!: (rows: KanbanBoardSummary[]) => void;
    f.catalogChanged.mockClear(); f.catalog.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    f.sidebar.invalidate(); await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    f.catalog.mockResolvedValue([board('Latest')]); f.sidebar.invalidate(); finish([]);
    await vi.waitFor(() => expect(f.container.textContent).toContain('Latest'));
    expect(f.catalogChanged).toHaveBeenCalledExactlyOnceWith([board('Latest')]);
});
it('retains the list and safe error cause after failure, then retries and refreshes it', async () => {
    const f = await fixture(); f.catalog.mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    f.sidebar.invalidate();
    await vi.waitFor(() => expect(f.container.querySelector('[role=alert]')!.textContent).toBe(t('kanban.errors.EIO')));
    expect(f.container.textContent).toContain('Initial'); expect(f.container.textContent).not.toContain('PRIVATE_BODY');
    f.catalog.mockResolvedValue([board('Recovered')]); f.sidebar.invalidate();
    await vi.waitFor(() => expect(f.container.textContent).toContain('Recovered'), {timeout: 2500});
    expect(f.container.querySelector<HTMLElement>('[role=alert]')!.hidden).toBe(true);
});
it('coalesces hidden changes and discards a response that arrives after destruction', async () => {
    const f = await fixture(); f.sidebar.setVisible(false); f.catalog.mockClear();
    f.sidebar.invalidate(); f.sidebar.invalidate(); await new Promise(resolve => setTimeout(resolve, 150)); expect(f.catalog).not.toHaveBeenCalled();
    f.sidebar.setVisible(true); await vi.waitFor(() => expect(f.catalog).toHaveBeenCalledTimes(1));
    let finish!: (boards: KanbanBoardSummary[]) => void;
    f.catalog.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})); f.sidebar.invalidate();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); f.sidebar.destroy(); finish([board('Late')]);
    await Promise.resolve(); await Promise.resolve(); expect(f.container.textContent).toBe(''); expect(f.report).not.toHaveBeenCalled();
});

it('uses one accessible settings dialog, rejects stale writes and retains partial failure details', async () => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable:true, writable:true, value() {}});
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable:true, writable:true, value() {}});
    const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function(this: HTMLDialogElement) {this.open = true;});
    vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function(this: HTMLDialogElement) {this.open = false; this.dispatchEvent(new Event('close'));});
    const rows = [{...board('A'),revision:4}, {...board('B'),revision:8}];
    const execute = vi.fn(async (id: string) => {if (id === 'B') throw Object.assign(new Error('PRIVATE_BODY'), {code:'REVISION_CONFLICT'}); return {} as never;});
    const report=vi.fn(), changed=vi.fn(async()=>controls.update(rows.map(row=>({...row,executionPhase:'manual' as const}))));
    const controls = new KanbanSidebarControls({execute} as unknown as KanbanClient,changed,report);
    cleanups.push(()=>controls.destroy()); controls.open(rows); controls.open(rows); expect(show).toHaveBeenCalledTimes(1);
    const dialog=document.querySelector('dialog')!,scope=dialog.querySelector('select')!;
    expect(scope.getAttribute('aria-label')).toBe(t('kanban.boardControl.scope')); expect(scope.value).toBe('*');
    const manual=dialog.querySelector<HTMLButtonElement>('[data-board-control=manual]')!;
    expect(manual.querySelector('svg')).not.toBeNull(); manual.click(); manual.click();
    await vi.waitFor(()=>expect(changed).toHaveBeenCalledTimes(1));
    expect(execute).toHaveBeenCalledTimes(2);expect(execute.mock.calls[0][0]).toBe('A');
    expect(execute.mock.calls[1][0]).toBe('B');
    const request=(execute.mock.calls[0] as unknown as [string,{expectedRevision:number}])[1];expect(request.expectedRevision).toBe(4);
    expect(dialog.textContent).toContain('REVISION_CONFLICT'); expect(dialog.textContent).not.toContain('PRIVATE_BODY');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({code:'BOARD_CONTROL_PARTIAL_FAILURE'}));
    controls.update([{...rows[0],executionPhase:'paused',executionControl:{paused:true,mode:'automatic',controls:{}}},rows[1]]);
    scope.value='A';scope.dispatchEvent(new Event('change'));
    expect(dialog.querySelector<HTMLButtonElement>('[data-board-control=pause]')!.hidden).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>('[data-board-control=resume]')!.hidden).toBe(false);
    show.mockRestore();
});

it('keeps the exact harness settings request on an unknown reply and restores it when reopening',async()=>{
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value(){this.open=true;}});
 Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value(){this.open=false;this.dispatchEvent(new Event('close'));}});
 const execute=vi.fn().mockRejectedValueOnce(Object.assign(new Error('uncertain'),{code:'EIO',outcome:'unknown'})).mockResolvedValue({});
 const service={read:async()=>({...board('A'),revision:4,settings:{target:'codex'}}),boardSettings:async()=>({fields:[{name:'target',label:'Harness',choices:[{value:'codex',label:'Codex'},{value:'claude',label:'Claude'}]}]}),execute} as unknown as KanbanClient;
 const controls=new KanbanSidebarControls(service,async()=>{},vi.fn());cleanups.push(()=>controls.destroy());controls.open([{...board('A'),revision:4}],'A');
 await vi.waitFor(()=>expect(document.querySelector('[data-board-settings=A]')).not.toBeNull());
 let form=document.querySelector<HTMLFormElement>('[data-board-settings=A]')!;form.querySelector<HTMLSelectElement>('select')!.value='claude';form.requestSubmit();
 await vi.waitFor(()=>expect(form.querySelector('[role=alert]')).not.toBeNull());const original=execute.mock.calls[0][1];
 expect(form.querySelector<HTMLSelectElement>('select')!.disabled).toBe(true);document.querySelector<HTMLDialogElement>('dialog')!.close();
 controls.open([{...board('A'),revision:4}],'A');await vi.waitFor(()=>expect(document.querySelector('[data-board-settings=A]')).not.toBeNull());
 form=document.querySelector<HTMLFormElement>('[data-board-settings=A]')!;form.requestSubmit();await vi.waitFor(()=>expect(execute).toHaveBeenCalledTimes(2));
 expect(execute.mock.calls[1][1]).toEqual(original);expect(original.command.settings.target).toBe('claude');
});

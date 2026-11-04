// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {KanbanSidebarControls} from '../src/kanban/sidebar-controls';
import {t} from '@itookit/common';
import type {KanbanBoardSummary, KanbanClient} from '@itookit/kanban/contracts';
import {KanbanSidebar} from '../src/kanban/sidebar';

const cleanups: Array<() => void> = [];
afterEach(() => {cleanups.splice(0).forEach(close => close()); document.body.replaceChildren();});
const board = (id: string): KanbanBoardSummary => ({id, title: id, number: 1, items: []} as unknown as KanbanBoardSummary);
async function fixture() {
    const catalog = vi.fn(async () => [board('Initial')]), report = vi.fn(), navigate = vi.fn(async () => {});
    const container = document.createElement('aside'); document.body.append(container);
    const sidebar = new KanbanSidebar({container, service: {catalog} as unknown as KanbanClient, navigate, create: vi.fn(), report});
    cleanups.push(() => sidebar.destroy()); await sidebar.start();
    return {sidebar, container, catalog, report, navigate};
}
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

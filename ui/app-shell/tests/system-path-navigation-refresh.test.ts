// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';

it('joins an in-flight invalidation before reusing a project navigation scope', async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => {finish = resolve;});
    const sync = vi.fn(async () => {}), trackSelection = vi.fn(), refresh = vi.fn(async () => {await gate; workbench.navigationDirty = false;});
    const {ViewRefresh} = await import('../src/lifecycle/view-refresh');
    const workbench = Object.assign(Object.create(SessionWorkbench.prototype), {
        closed:false,visible:true,navigationVisible:true,navigationReady:true,navigationDirty:true,active:'/folder:P/@files/file.rs',
        sidebarLayout:{activeView:'navigation',navigation:{inert:false}},fileNavigationRevision:0,directorySelectionRevision:0,
        fileNavigation:Promise.resolve(),projectNavigation:{sync,trackSelection},tabs:{current:undefined},directoryNavigation:new WeakMap(),
        sidebarUI:{},editor:{},previewCleanup:undefined,report:vi.fn(),
    });
    workbench.viewRefresh = new ViewRefresh({visible:()=>true,run:refresh,report:vi.fn()});
    workbench.viewRefresh.mark('files',false);
    const running = workbench.viewRefresh.flush();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    (SessionWorkbench.prototype as any).scheduleNavigation.call(workbench, workbench.active, {reuseScope:true}, false);
    expect(sync).not.toHaveBeenCalled(); finish(); await running; await workbench.fileNavigation;
    expect(sync).not.toHaveBeenCalled(); expect(trackSelection).toHaveBeenCalledOnce();
    await workbench.viewRefresh.close();
});

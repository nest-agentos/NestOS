// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {ViewLoad} from '../src/lifecycle/view-load';
import {SessionWorkbench} from '../src/projects/SessionWorkbench';

it('releases an interrupted prepared workspace and removes it from the pending reopen', async () => {
    const controller = new AbortController(), dispose = vi.fn(async () => {});
    const workspace = {fs:{driver:{}},initialFile:{node:{type:'file',size:10},readonly:true},dispose};
    const opening = {value:{project:{path:'/fixture',project:{id:'fixture'}},path:'file.rs',workspace},claimed:false};
    const options = {systemPathOpening:opening}; let cleanup: Promise<void> | undefined;
    const workbench = Object.assign(Object.create(SessionWorkbench.prototype), {
        projects:{},pendingTarget:{options},tabs:{},hostContext:undefined,
        projectForOpen:async () => opening.value.project,
        editorMount:async () => {controller.abort(); return document.createElement('div');},
        finishReads:(value:Promise<void>) => {cleanup=value;},
    });
    await expect((workbench as any).openProjectFile('/fixture/@files/file.rs',
        {folder:'/fixture',path:'/workspace/file.rs'},new ViewLoad(controller.signal),opening)).rejects.toThrow();
    await cleanup;
    expect(opening.claimed).toBe(true); expect(options.systemPathOpening).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
});

it('keeps an existing all-project scope when a path opens without a selected project', () => {
    const scheduleNavigation = vi.fn();
    const workbench = Object.assign(Object.create(SessionWorkbench.prototype), {
        projectNavigation:{currentProject:() => undefined},scheduleNavigation,
    });
    (workbench as any).scheduleFileNavigation('/folder:fixture/@files/file.rs','preserve');
    expect(scheduleNavigation).toHaveBeenCalledWith('/folder:fixture/@files/file.rs',expect.objectContaining({reuseScope:true}),false);
});

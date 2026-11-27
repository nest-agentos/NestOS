import {expect, it,vi} from 'vitest';
import {initialView} from '../src/client/initial-view';
import {INITIAL_CHAT_DOCUMENTS} from '@nestos/app-shell/startup';

it.each(['/', '/folder:x1', '/folder:x1/@conversations', '/folder:x1/@favorites', '/folder:x1/@files/a.md', '/s1/tasks'])(
    'does not preload the chat editor for directory or task route %s', resource => {
        const view = initialView('#/workbench/' + encodeURIComponent(resource));
        expect(view.editor).toBeUndefined(); expect(view.request).toBeDefined();
    });
it.each(['s1?branch=main', 'draft:66fc56b1-76c5-4067-9876-52259d99795c', '/folder:x1/@new'])(
    'preloads chat for conversation route %s', resource => {
        expect(initialView('#/workbench/' + encodeURIComponent(resource)).editor).toBe('chat');
    });
it('includes draft preferences in the resource bootstrap and defers the event stream', () => {
    const path = '/folder:x1/@new', view = initialView('#/workbench/' + encodeURIComponent(path));
    expect(view.deferEvents).toBe(true);
    expect(view.request?.resourceId).toBe(path);
    expect(view.request?.documents).toEqual(INITIAL_CHAT_DOCUMENTS);
});
it('requests the native composer but skips the hidden compact sidebar', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));
    try {
        const view = initialView('#/workbench/' + encodeURIComponent('/folder:x1/@harness/codex/s1'));
        expect(view.editor).toBe('native');
        expect(view.request?.initialPage).toMatchObject({sidebar: false, composer: true});
    } finally {vi.unstubAllGlobals();}
});
it('retains flow preloading and skips chat on the workspace landing page', () => {
    expect(initialView('#/flows').editor).toBe('flows');
    expect(initialView('#/workbench').editor).toBeUndefined();
});
it('declares only route-required startup reads and includes decision query conditions',()=>{
 const decision=initialView('#/kanban/'+encodeURIComponent('/board/development/@decision'));
 expect(decision.initialRead).toEqual(expect.objectContaining({documents:['theme','nestos_assistant_menu_v1'],eventBaseline:true,decision:{boardId:'development',query:expect.objectContaining({sort:'activity-desc',sections:['page','catalog','projects'],attentionOnly:false,archived:false})}}));
 expect(initialView('#/flows').initialRead?.decision).toBeUndefined();expect(initialView('#/workbench').initialRead).toBeUndefined();
});
it('prepares an authorized task snapshot only for a task detail route',()=>{
 const read=initialView('#/kanban/'+encodeURIComponent('/board/development/task-1')).initialRead;
 expect(read?.task).toEqual({boardId:'development',itemId:'task-1'});
 expect(read?.documents).toEqual(['theme']);
 expect(initialView('#/kanban/'+encodeURIComponent('/board/development/@worktrees')).initialRead?.task).toBeUndefined();
});
it('omits sidebar catalog data when opening a task from a compact viewport',()=>{
 vi.stubGlobal('matchMedia',vi.fn(()=>({matches:true})));
 try{expect(initialView('#/kanban/'+encodeURIComponent('/board/development/task-1')).initialRead?.task).toEqual({boardId:'development',itemId:'task-1',includeSidebar:false});}
 finally{vi.unstubAllGlobals();}
});

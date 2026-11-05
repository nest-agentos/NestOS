import {expect, it, vi} from 'vitest';
import {kanbanSidebarDeletion} from '../src/kanban/sidebar-deletion';
import type {KanbanClient, KanbanDeletionPreview} from '@nestos/kanban/contracts';
import {t} from '@nestos/common';
it('uses task names, groups shared resources, translates reasons and separates technical diagnostics', async () => {
    const resource = {id: 'tree-id', kind: 'git-worktree', title: 'Git worktree', location: '/private/tree-id', state: 'retained', canCleanup: false, reasons: ['WORKTREE_TASK_UNFINISHED'], version: 'v', properties: []};
    const data = {boardId: 'board', title: 'Development', revision: 3, version: 'v', pendingItems: 2,
        itemTitles: {'opaque-id': 'Readable task', 'another-id': 'Related task'},
        blockers: [{code: 'BOARD_EXECUTION_ACTIVE', itemId: 'opaque-id'}, {code: 'BOARD_EXECUTION_ACTIVE', itemId: 'opaque-id'}],
        resources: [{itemId: 'opaque-id', resource}, {itemId: 'another-id', resource}]} as KanbanDeletionPreview;
    const service = {previewDeletion: vi.fn(async () => data), deleteBoard: vi.fn()} as unknown as KanbanClient;
    const port = kanbanSidebarDeletion(service, vi.fn())!;
    const preview = await port.preview({id: '/board/board', label: 'Development', kind: 'folder', parentId: null}, new AbortController().signal);
    expect(preview.blocked).toBe(true); expect(preview.message).toContain('Readable task'); expect(preview.message).toContain('Related task');
    expect(preview.message.split('Git worktree')).toHaveLength(2);
    expect(preview.message).toContain(t('kanban.workResourceReason.WORKTREE_TASK_UNFINISHED'));
    expect(preview.message).not.toMatch(/opaque-id|WORKTREE_TASK_UNFINISHED|\/private\//);
    expect(preview.details?.text).toContain('opaque-id'); expect(preview.details?.text).toContain('/private/tree-id');
});

it('offers persistent deferred deletion, explains automatic completion and keeps the pending board visible',async()=>{
    const data={boardId:'board',title:'Pending',revision:3,version:'version',pendingItems:1,itemTitles:{task:'Task'},blockers:[{code:'BOARD_FIX_UNSETTLED',itemId:'task'}],resources:[]} as KanbanDeletionPreview;
    const requestBoardDeletion=vi.fn(),removed=vi.fn(),scheduled=vi.fn();
    const service={previewDeletion:vi.fn(async()=>data),deleteBoard:vi.fn(),requestBoardDeletion} as unknown as KanbanClient;
    const port=kanbanSidebarDeletion(service,removed,scheduled)!;
    const node={id:'/board/board',label:'Pending',kind:'file' as const,parentId:null},signal=new AbortController().signal;
    const preview=await port.preview(node,signal);
    expect(preview.blocked).toBe(false);expect(preview.message).toContain(t('kanban.deleteDeferredDescription'));
    await port.remove(node,preview,new Set(),signal);
    expect(requestBoardDeletion).toHaveBeenCalledWith('board',expect.objectContaining({mode:'drain',expectedRevision:3}));
    expect(removed).not.toHaveBeenCalled();expect(scheduled).toHaveBeenCalledOnce();expect(service.deleteBoard).not.toHaveBeenCalled();
});

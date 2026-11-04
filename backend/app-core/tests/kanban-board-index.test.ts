import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '../src/kanban/automation-journal';
import {boardIndexPath} from '../src/kanban/automation-board-index';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/');
    await fs.driver.createFile({parentPath: '/var/lib/kanban', name: 'automation.seq', type: 'seqfile', recursive: true});
    return {fs, journal: new KanbanAutomationJournal(fs)};
}
it('migrates legacy records once and reads only references belonging to the requested board', async () => {
    const {fs, journal} = await fixture();
    await fs.meta.seq!.setEntries('/var/lib/kanban/automation.seq', {
        'review-operation:a': JSON.stringify({boardId: 'a', itemId: 'task', phase: 'prepared'}),
        'review-operation:b': JSON.stringify({boardId: 'b', itemId: 'other', phase: 'prepared'}),
        'record-runs:a': JSON.stringify([{sourceBoardId: 'a', boardId: 'child', state: 'running'}]),
    });
    await journal.open();
    // Corrupt an unrelated source after migration: scoped reads and reopen must never parse it.
    await fs.meta.seq!.setEntry('/var/lib/kanban/automation.seq', 'review-operation:b', 'INVALID_JSON');
    expect(await journal.findForBoard('review-operation:', 'a', () => true)).toEqual([{key: 'review-operation:a', value: {boardId: 'a', itemId: 'task', phase: 'prepared'}}]);
    expect(await fs.meta.seq!.getEntry(boardIndexPath, 'version')).toBe('1');
    expect(await journal.findForBoard('record-runs:', 'child', () => true)).toHaveLength(1);
    await new KanbanAutomationJournal(fs).open();
    expect(await journal.findForBoard('review-operation:', 'a', () => true)).toHaveLength(1);
});
it('updates references atomically, including in-place changes, and rolls back failed writes', async () => {
    const {journal} = await fixture(); await journal.open();
    await journal.update('fix:f', () => ({boardId: 'a'}));
    await journal.update<{boardId: string}>('fix:f', old => {old!.boardId = 'b'; return old!;});
    expect(await journal.findForBoard('fix:', 'a', () => true)).toEqual([]);
    expect(await journal.findForBoard('fix:', 'b', () => true)).toHaveLength(1);
    await expect(journal.update('fix:f', () => {throw new Error('FAILED');})).rejects.toThrow('FAILED');
    expect(await journal.findForBoard('fix:', 'b', () => true)).toHaveLength(1);
    expect(await journal.getMany(['fix:f', 'absent'])).toEqual([{boardId: 'b'}, undefined]);
});

it('rolls back an interrupted migration and retries it without a partial index', async () => {
    const {fs, journal} = await fixture(), path = '/var/lib/kanban/automation.seq';
    await fs.meta.seq!.setEntries(path, {'review-operation:a': JSON.stringify({boardId: 'a'}), 'review-operation:z': 'INVALID_JSON'});
    await expect(journal.open()).rejects.toThrow();
    expect(await fs.meta.seq!.getEntry(boardIndexPath, 'version')).toBeNull();
    expect(await journal.findForBoard('review-operation:', 'a', () => true)).toEqual([]);
    await fs.meta.seq!.setEntry(path, 'review-operation:z', JSON.stringify({boardId: 'z'}));
    await journal.open();
    expect(await journal.findForBoard('review-operation:', 'a', () => true)).toHaveLength(1);
});

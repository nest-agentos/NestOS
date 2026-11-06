import {expect, it, vi} from 'vitest';
import type {KanbanBoard} from '@nestos/kanban/contracts';
import {kanbanSessionResource} from '../src/kanban/session-resource';
function board() {
    const native = {system: 'nestos-native-session', id: 'original-native', revision: JSON.stringify({projectId: 'project', profileId: 'codex', dispatchId: 'dispatch'})};
    return {id: 'board', revision: 1, items: [{externalRefs: [
        {system: 'nestos-remote-project', id: 'project'},
        {system: 'nestos-execution-session', id: 'node-session', revision: 'dispatch'}, native, {...native},
        {system: 'nestos-native-session', id: 'old-native', revision: JSON.stringify({projectId: 'project', profileId: 'codex', dispatchId: 'old-dispatch'})},
    ]}]} as unknown as KanbanBoard;
}
it('uses explicit dispatch linkage to the original native Session without an unrelated context scan', async () => {
    const get = vi.fn(async () => ({path: '/x1'})), fallback = vi.fn(async () => undefined), resolve = kanbanSessionResource({get} as never, fallback);
    expect(await resolve('node-session', 'main', board())).toBe('/folder:x1/@harness/codex/original-native');
    expect(get).toHaveBeenCalledExactlyOnceWith('project'); expect(fallback).not.toHaveBeenCalled();
});
it('does not follow a native reference belonging to a different task project', async () => {
    const b = board(), refs = b.items[0].externalRefs!; refs[0].id = 'different-project';
    const get = vi.fn(), fallback = vi.fn(async () => 'fallback'), resolve = kanbanSessionResource({get} as never, fallback);
    expect(await resolve('node-session', 'main', b)).toBe('fallback'); expect(get).not.toHaveBeenCalled();
});
it('refreshes the cached projection when a board revision changes', async () => {
    const b = board(), resolve = kanbanSessionResource({get: async () => ({path: '/x1'})} as never, async () => undefined);
    expect(await resolve('node-session', 'main', b)).toContain('original-native');
    b.items[0].externalRefs = b.items[0].externalRefs!.map(ref => ref.id === 'original-native' ? {...ref, id: 'replacement-native'} : ref); b.revision++;
    expect(await resolve('node-session', 'main', b)).toContain('replacement-native');
});
it('does not guess between two native Sessions for the same execution', async () => {
    const b = board(), ref = b.items[0].externalRefs!.find(ref => ref.id === 'original-native')!;
    b.items[0].externalRefs!.push({...ref, id: 'ambiguous-native'});
    const get = vi.fn(), fallback = vi.fn(async () => undefined);
    expect(await kanbanSessionResource({get} as never, fallback)('node-session', 'main', b)).toBeUndefined();
    expect(get).not.toHaveBeenCalled(); expect(fallback).toHaveBeenCalledOnce();
});

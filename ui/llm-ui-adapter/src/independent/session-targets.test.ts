import {expect, it, vi} from 'vitest';
import {SessionCallTargets} from './session-targets';
import {restoreDraftTarget} from './restore-draft-target';

it('filters Agent targets in the editor context and preserves a revoked selection without replacement', async () => {
    const target = (kind: 'agent' | 'flow', id: string) => ({kind, id, version: 'v1', digest: 'a'.repeat(64)});
    const a = target('agent', 'a'), b = target('agent', 'b'), flow = target('flow', 'f');
    const commands = {execute: vi.fn(async () => ({entries: [{target: a, name: 'A'}, {target: b, name: 'B'}, {target: flow, name: 'Flow'}], issues: []}))};
    let allowed = ['a'];
    const targets = new SessionCallTargets(commands as never, () => {}, false, async ids => ids.filter(id => allowed.includes(id)));
    await targets.refresh(); expect(targets.getSnapshot().entries.map(item => item.target.id)).toEqual(['a', 'f']);
    const draft = {target: a, text: 'Retained draft', revision: 1} as never;
    allowed = ['b']; await targets.refreshCurrent();
    expect(targets.getSnapshot().entries.map(item => item.target.id)).toEqual(['b', 'f']);
    expect(restoreDraftTarget(draft, targets.getSnapshot())).toBe(draft);
    targets.dispose();
});

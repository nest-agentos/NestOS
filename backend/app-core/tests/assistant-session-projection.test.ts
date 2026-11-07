import {expect, it, vi} from 'vitest';
import {startAssistantSessions} from '../src/assistant/session-projection';
import {assistantOverview} from '../src/assistant/overview';
import type {LocalApplicationServices} from '@nestos/app-contracts/services';
function fixture(size = 1135) {
    const rows = Array.from({length: size}, (_, index) => ({id: 's-' + index, title: 'Session ' + index, updatedAt: index}));
    let kernelChanged!: (event: {sessionId: string; reason: string}) => void, repositoryChanged!: (change: {sessionId: string}) => void;
    const pending = new Set<string>(), removed = new Set<string>();
    const sessionActivity = vi.fn(async (id: string) => {
        if (removed.has(id)) throw Object.assign(new Error('Missing'), {code: 'SESSION_NOT_FOUND'});
        return {pending: {approval: pending.has(id) ? 1 : 0}, counts: {}, latestExit: {status: 'succeeded', at: Number(id.slice(2))}};
    });
    const listSummaries = vi.fn(async () => rows);
    const services = {kernel: {kernel: {sessionActivity, onChanged: (listener: typeof kernelChanged) => {kernelChanged = listener; return vi.fn();}}},
        sessionRepository: {listSummaries, getManifest: async (id: string) => rows.find(row => row.id === id)!,
            subscribe: (listener: typeof repositoryChanged) => {repositoryChanged = listener; return vi.fn();}}} as unknown as LocalApplicationServices;
    return {services, sessionActivity, listSummaries, pending, removed, rows,
        change: (id: string) => kernelChanged({sessionId: id, reason: 'structure'}), rename: (id: string) => repositoryChanged({sessionId: id})};
}
it('seeds once, then reads no unrelated Sessions for repeated home refreshes and preserves every actionable item', async () => {
    const f = fixture(); for (let index = 0; index < 120; index++) f.pending.add('s-' + index);
    const stop = await startAssistantSessions(f.services);
    try {
        expect(f.sessionActivity).toHaveBeenCalledTimes(1135); f.sessionActivity.mockClear(); f.listSummaries.mockClear();
        const first = await assistantOverview(f.services); await assistantOverview(f.services);
        expect(first.events.filter(row => row.requiresAction)).toHaveLength(120);
        expect(first.events.filter(row => !row.requiresAction)).toHaveLength(100);
        expect(f.sessionActivity).not.toHaveBeenCalled(); expect(f.listSummaries).not.toHaveBeenCalled();
        f.pending.add('s-1134'); f.change('s-1134');
        expect((await assistantOverview(f.services)).events.find(row => row.id === 'session:s-1134')?.requiresAction).toBe(true);
        expect(f.sessionActivity).toHaveBeenCalledExactlyOnceWith('s-1134');
        f.rows[1134].title = 'Renamed'; f.rename('s-1134');
        expect((await assistantOverview(f.services)).events.find(row => row.id === 'session:s-1134')?.title).toBe('Renamed');
        f.removed.add('s-1134'); f.change('s-1134');
        expect((await assistantOverview(f.services)).events.some(row => row.id === 'session:s-1134')).toBe(false);
    } finally {await stop();}
});
it('reports projection failure and recovers by retrying only the failed source, without leaking another runtime state', async () => {
    const f = fixture(2), stop = await startAssistantSessions(f.services);
    try {
        f.sessionActivity.mockRejectedValueOnce(new Error('Unavailable')); f.change('s-1');
        f.sessionActivity.mockRejectedValueOnce(new Error('Still unavailable'));
        expect((await assistantOverview(f.services)).unavailable).toContain('sessions');
        f.pending.add('s-1');
        const result = await assistantOverview(f.services);
        expect(result.unavailable).toEqual([]); expect(result.events[0].requiresAction).toBe(true);
        const other = fixture(1), release = await startAssistantSessions(other.services);
        try {expect((await assistantOverview(other.services)).events.map(row => row.id)).toEqual(['session:s-0']);}
        finally {await release();}
    } finally {await stop();}
});

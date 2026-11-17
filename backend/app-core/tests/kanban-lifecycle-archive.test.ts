import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {kanbanJournalOptions} from '../src/kanban/host-policy';
import {UserEventService} from '../src/events/service';
import {developmentLifecycle} from '../src/presets/kanban-development-lifecycle';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), journal = new KanbanAutomationJournal(fs, kanbanJournalOptions); await journal.open();
    const events = await UserEventService.open(fs), id = 'attempt-postload-failed', key = 'development-lifecycle:' + id;
    const dispatch = {id, itemId: 'item'}, input = {request: {expectedSessionId: id, submission: {id}}};
    const job = {id, boardId: 'board', dispatch, stage: 'postload.failed', phase: 'settled', done: true,
        request: {schema: 1, dispatch, input, policy: {maxDepth: 4}}, observation: {outcome: 'succeeded', executionSessionId: 'temporary-child'}};
    await journal.update(key, () => job); await journal.update('development-lifecycle-index', () => [key]);
    const inspect = vi.fn(async () => ({outcome: 'succeeded', sessionId: 'temporary-child'})), archiveSession = vi.fn(async () => {});
    const calls = {prepareTaskCall: vi.fn(), submitPreparedTaskCall: vi.fn()}, prepareSession = vi.fn();
    const options = {journal, events, calls, prepareSession, execution: {inspect}, archiveSession};
    const open = () => {const lifecycle = developmentLifecycle(options as never); closes.push(() => lifecycle.dispose()); return lifecycle;};
    return {journal, events, key, id, job, inspect, archiveSession, calls, prepareSession, open};
}

it('archives only the settled temporary child after saving its notification, including after restart', async () => {
    const f = await fixture();
    f.archiveSession.mockImplementation(async () => {expect((await f.events.listNotifications()).items).toHaveLength(1);});
    await f.open().scan(); await f.open().scan();
    expect(f.archiveSession).toHaveBeenCalledExactlyOnceWith('temporary-child', 'lifecycle-archive:' + f.id);
    expect(await f.journal.get(f.key)).toMatchObject({done: true, archivedSessionId: 'temporary-child'});
    expect(f.prepareSession).not.toHaveBeenCalled(); expect(f.calls.prepareTaskCall).not.toHaveBeenCalled(); expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
});

it('retries uncertain archival with the same operation identity without rerunning the hook', async () => {
    const f = await fixture();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    f.archiveSession.mockRejectedValueOnce(Object.assign(new Error('private connection detail'), {code: 'SESSION_ARCHIVE_OUTCOME_UNKNOWN'}));
    const lifecycle = f.open(); await lifecycle.scan(); await lifecycle.dispose();
    expect(await f.journal.get(f.key)).toMatchObject({done: true}); expect((await f.journal.get<{archivedSessionId?: string}>(f.key))?.archivedSessionId).toBeUndefined();
    const reopened = f.open(); await reopened.scan(); expect(f.archiveSession).toHaveBeenCalledOnce();
    clock.mockReturnValue(now + 60_000); await reopened.scan();
    expect(f.archiveSession.mock.calls).toEqual([['temporary-child', 'lifecycle-archive:' + f.id], ['temporary-child', 'lifecycle-archive:' + f.id]]);
    expect((await f.events.listNotifications()).items).toHaveLength(1); expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[KanbanDevelopment]', expect.objectContaining({operationId: f.id, stage: 'lifecycle.archive', result: 'failure', code: 'SESSION_ARCHIVE_OUTCOME_UNKNOWN', durationMs: expect.any(Number)}));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private connection detail');
});

it('keeps unsettled, unknown and changed executions and waits for a confirmed terminal receipt', async () => {
    const f = await fixture(), lifecycle = f.open();
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (const observation of [{outcome: 'running', sessionId: 'temporary-child'}, {outcome: 'unknown', sessionId: 'temporary-child'},
        {outcome: 'failed', sessionId: 'different-child'}, {outcome: 'succeeded', sessionId: f.id}, {outcome: 'unknown'}]) {
        f.inspect.mockResolvedValueOnce(observation as never); await lifecycle.scan(); expect(f.archiveSession).not.toHaveBeenCalled();
        now += 300_000;
    }
    f.inspect.mockResolvedValueOnce({outcome: 'cancelled', sessionId: 'temporary-child'}); await lifecycle.scan();
    expect(f.archiveSession).toHaveBeenCalledExactlyOnceWith('temporary-child', 'lifecycle-archive:' + f.id);
});

it('retains unavailable project bindings and throttles their archive checks across restart', async () => {
    const f = await fixture(), now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    f.archiveSession.mockRejectedValue(Object.assign(new Error('unavailable'), {code: 'SESSION_ARCHIVE_PROJECT_UNAVAILABLE'}));
    const first = f.open(); await first.scan(); await first.dispose();
    const reopened = f.open();
    clock.mockReturnValue(now + 60_000); await reopened.scan();
    expect(f.archiveSession).toHaveBeenCalledOnce();
    expect(await f.journal.get(f.key)).toMatchObject({done: true, archiveRetryAt: now + 300_000});
    clock.mockReturnValue(now + 300_000); await reopened.scan();
    expect(f.archiveSession).toHaveBeenCalledTimes(2); expect(f.calls.submitPreparedTaskCall).not.toHaveBeenCalled();
});

it('keeps the result pending for archival if its notification cannot be saved', async () => {
    const f = await fixture(), transaction = vi.spyOn(f.events.journal, 'transaction').mockRejectedValueOnce(new Error('storage unavailable'));
    const lifecycle = f.open(); await expect(lifecycle.scan()).rejects.toThrow('storage unavailable');
    expect(f.archiveSession).not.toHaveBeenCalled(); transaction.mockRestore();
    await lifecycle.scan(); expect(f.archiveSession).toHaveBeenCalledOnce();
});

it('refuses to archive a request that belongs to another caller Session', async () => {
    const f = await fixture();
    await f.journal.update(f.key, () => ({...f.job, request: {...f.job.request, input: {request: {expectedSessionId: 'management-session', submission: {id: f.id}}}}}));
    await f.open().scan();
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.archiveSession).not.toHaveBeenCalled();
});

import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend, SeqEventJournal} from '@nestos/vfs-core';
import type {ApplicationEvents, ApplicationEventFact} from '@nestos/app-contracts/services';
import {ShellApplicationEvents, workspaceConsumesEvent} from '../src/lifecycle/application-events';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks();});
async function fixture(retain = 1000) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const journal = await SeqEventJournal.open<ApplicationEventFact>(await manager.openFileSystem('/'), '/events.seq', 'user-a', retain);
    const source: ApplicationEvents = {eventBaseline: vi.fn(() => journal.baseline()),
        readEvents: vi.fn((after, limit) => journal.read(after, limit)), onChange: vi.fn(listener => journal.onChange(listener)),
        listNotifications: vi.fn(), setNotificationRead: vi.fn()};
    const invalidate = vi.fn(), visible = {value: true};
    const bridge = new ShellApplicationEvents(source, invalidate, () => visible.value); cleanup.push(() => bridge.close());
    return {source, journal, bridge, invalidate, visible};
}

it('replays changes between baseline and first paint independently in two browsers without acknowledging notifications', async () => {
    const f = await fixture(), other = vi.fn();
    const second = new ShellApplicationEvents(f.source, other, () => true); cleanup.push(() => second.close());
    await f.bridge.prepare(); await second.prepare();
    await f.journal.append('during-opening', {type: 'repository.changed'});
    await f.bridge.start(); await second.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
    expect(other).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
    f.bridge.close(); await f.journal.append('later', {type: 'task.failed'}); await second.refresh();
    expect(other).toHaveBeenCalledTimes(2); expect(f.invalidate).toHaveBeenCalledOnce();
    expect(f.source.setNotificationRead).not.toHaveBeenCalled();
});

it('skips an empty startup replay and still reads changes after the confirmed baseline', async () => {
    vi.useFakeTimers();
    const f = await fixture(), badge = vi.fn();
    await f.bridge.prepare(true, await f.journal.baseline(), 0);
    f.bridge.subscribeNotificationCount(badge);
    await f.bridge.start();
    expect(badge).toHaveBeenCalledWith(0);
    expect(f.source.readEvents).not.toHaveBeenCalled();
    await f.journal.append('after-bootstrap', {type: 'repository.changed'});
    await vi.advanceTimersByTimeAsync(350);
    expect(f.source.readEvents).toHaveBeenCalledOnce();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
});

it('repairs lost hints on the visible polling interval and leaves hidden windows idle', async () => {
    vi.useFakeTimers(); const f = await fixture();
    vi.mocked(f.source.onChange).mockImplementation(() => () => {});
    await f.bridge.prepare(); await f.bridge.start();
    f.visible.value = false;
    await f.journal.append('missed', {type: 'node:created', resourceId: '/note.md'});
    const reads = vi.mocked(f.source.readEvents).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.source.readEvents).toHaveBeenCalledTimes(reads); expect(f.invalidate).not.toHaveBeenCalled();
    f.visible.value = true; await vi.advanceTimersByTimeAsync(15000);
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'node:created', resourceId: '/note.md'});
    f.bridge.close(); await vi.advanceTimersByTimeAsync(30000);
    expect(vi.getTimerCount()).toBe(0);
});

it('reads one cursor page for a burst of live hints and catches up after being hidden', async () => {
    vi.useFakeTimers(); const f = await fixture();
    await f.bridge.prepare(); await f.bridge.start();
    vi.mocked(f.source.readEvents).mockClear();
    for (const id of ['first', 'second', 'third']) await f.journal.append(id, {type:'task.succeeded', resourceId:id});
    expect(f.source.readEvents).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(350);
    expect(f.source.readEvents).toHaveBeenCalledOnce();
    expect(f.invalidate.mock.calls.map(([event]) => event.resourceId)).toEqual(['first','second','third']);
    f.visible.value = false; await f.journal.append('hidden', {type:'task.succeeded', resourceId:'hidden'});
    await vi.advanceTimersByTimeAsync(350);
    expect(f.source.readEvents).toHaveBeenCalledOnce();
    f.visible.value = true; await f.bridge.refresh();
    expect(f.invalidate.mock.calls.map(([event]) => event.resourceId)).toEqual(['first','second','third','hidden']);
});

it('uses the same event read for the notification count, including pages with no new events', async () => {
    const f = await fixture(), badge = vi.fn();
    let unread = 2;
    vi.mocked(f.source.readEvents).mockImplementation(async (after, limit, include) =>
        ({...await f.journal.read(after, limit), ...(include && {unreadNotifications: unread})}));
    const stop = f.bridge.subscribeNotificationCount(badge);
    await f.bridge.prepare(); await f.bridge.start();
    expect(f.source.readEvents).toHaveBeenCalledExactlyOnceWith(expect.anything(), undefined, true);
    expect(badge).toHaveBeenLastCalledWith(2);
    unread = 1; await f.bridge.refresh(); expect(badge).toHaveBeenLastCalledWith(1);
    stop(); unread = 0; await f.bridge.refresh(); expect(badge).toHaveBeenCalledTimes(2);
});

it('retries a failed initial subscription without losing its baseline or leaking error bodies', async () => {
    const f = await fixture(), warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await f.bridge.prepare(); await f.journal.append('before-failure', {type: 'task.succeeded'});
    vi.mocked(f.source.readEvents).mockRejectedValueOnce(Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'}));
    await f.bridge.start(); expect(f.invalidate).not.toHaveBeenCalled();
    await f.bridge.refresh();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'task.succeeded'});
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_BODY');
});

it('reconciles preloaded snapshots once and recovers a failed baseline with a fresh reset', async () => {
    const f = await fixture();
    await f.bridge.prepare(true); await f.bridge.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    const other = await fixture();
    vi.mocked(other.source.eventBaseline).mockRejectedValueOnce({code: 'EIO'});
    await other.bridge.prepare(); await other.journal.append('unseen', {type: 'node:created'}); await other.bridge.start();
    expect(other.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    await other.journal.append('after-baseline', {type: 'node:deleted'}); await other.bridge.refresh();
    expect(other.invalidate).toHaveBeenLastCalledWith({type: 'node:deleted'});
});

it('resets an expired cursor and delivers reset markers once instead of replaying domain commands', async () => {
    const f = await fixture(2); await f.bridge.prepare();
    for (let n = 0; n < 3; n++) await f.journal.append(String(n), {type: 'task.succeeded'});
    await f.bridge.start();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'runtime.reset'});
    await f.journal.append('restart', {type: 'runtime.reset'}); await f.bridge.refresh();
    expect(f.invalidate).toHaveBeenCalledTimes(2);
});

it('closes safely while an initial read is pending', async () => {
    const f = await fixture(); await f.bridge.prepare();
    const read = f.source.readEvents.bind(f.source); let finish!: () => void;
    const gate = new Promise<void>(resolve => {finish = resolve;});
    vi.mocked(f.source.readEvents).mockImplementationOnce(async (...args) => {await gate; return read(...args);});
    const starting = f.bridge.start();
    f.bridge.close(); await f.journal.append('late', {type: 'task.failed'}); finish(); await starting;
    expect(f.invalidate).not.toHaveBeenCalled();
});

it('routes execution and scanner facts to their owning workspaces and resets every workspace', () => {
    expect(workspaceConsumesEvent('chat', {type: 'task.failed'})).toBe(true);
    expect(workspaceConsumesEvent('standard', {type: 'task.failed'})).toBe(false);
    expect(workspaceConsumesEvent('standard', {type: 'node:created'})).toBe(true);
    expect(workspaceConsumesEvent('twin', {type: 'scanner.changed'})).toBe(true);
    expect(workspaceConsumesEvent('toolbox', {type: 'scanner.changed'})).toBe(false);
    for (const kind of ['chat', 'standard', 'toolbox', 'twin']) expect(workspaceConsumesEvent(kind, {type: 'runtime.reset'})).toBe(true);
});

it('routes kanban facts to kanban views without treating notifications as execution commands', () => {
    expect(workspaceConsumesEvent('kanban', {type: 'kanban.escalated.unclaimed', notification: 'error'})).toBe(true);
    expect(workspaceConsumesEvent('kanban', {type: 'task.failed'})).toBe(false);
    expect(workspaceConsumesEvent('chat', {type: 'kanban.claim'})).toBe(false);
});

it('uses the prepared baseline and distributes an ordered page batch through one upstream subscription',async()=>{
 const f=await fixture(),receive=vi.fn();const baseline=await f.journal.baseline();
 await f.bridge.prepare(false,baseline);const stop=f.bridge.subscribe(receive);
 await f.journal.transaction(async tx=>{await tx.append('one',{type:'repository.changed'});await tx.append('two',{type:'scanner.changed'});});
 await f.bridge.start();expect(f.source.eventBaseline).not.toHaveBeenCalled();expect(f.source.onChange).toHaveBeenCalledOnce();
 expect(receive).toHaveBeenCalledExactlyOnceWith([{type:'repository.changed'},{type:'scanner.changed'}]);expect(f.invalidate).toHaveBeenCalledTimes(2);
 stop();await f.journal.append('three',{type:'task.failed'});await f.bridge.refresh();expect(receive).toHaveBeenCalledOnce();
});

it('replays from the baseline captured before preloaded snapshots without resetting the whole workspace', async () => {
    const f = await fixture(), baseline = await f.journal.baseline();
    await f.journal.append('during-snapshot', {type: 'repository.changed'});
    await f.bridge.prepare(true, baseline); await f.bridge.start();
    expect(f.source.eventBaseline).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledExactlyOnceWith({type: 'repository.changed'});
});

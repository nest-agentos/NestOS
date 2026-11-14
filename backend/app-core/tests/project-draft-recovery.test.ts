import { it, expect, vi } from 'vitest';
import { attachProjectDraftRecovery } from '../src/runtime/project-draft-recovery';
import {ProjectDraftService} from '../src/projects/drafts/service';

it('unsubscribes and drains in-flight reconciliation before closing storage', async () => {
    let receive!: (event: any) => void, finish!: () => void;
    const submitted = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const unsubscribe = vi.fn(), recover = vi.fn(async () => {});
    const close = await attachProjectDraftRecovery({ submitted, recover } as any, {
        onGlobalEvent: (listener: any) => { receive = listener; return unsubscribe; },
    } as any);
    receive({ type: 'session_registered', payload: { sessionId: 'ordinary' } });
    expect(submitted).not.toHaveBeenCalled();
    receive({ type: 'execution_task_projected', payload: { sessionId: 's', roundId: 'r' } });
    let closed = false; const closing = close().then(() => { closed = true; });
    await Promise.resolve(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(closed).toBe(false);
    finish(); await closing; expect(closed).toBe(true);
});

it('retries recovery with bounded backoff, resumes after success and clears its timer on close', async () => {
    vi.useFakeTimers();
    const report = vi.fn(), recover = vi.fn().mockRejectedValue(Object.assign(new TypeError('private endpoint'), {cause: {code: 'ECONNREFUSED'}}));
    const close = await attachProjectDraftRecovery({recover, submitted: vi.fn()}, {onGlobalEvent: () => vi.fn()} as any,
        false, {periodic: true, report});
    try {
        await expect(close.recover()).rejects.toThrow();
        expect(JSON.stringify(report.mock.calls)).not.toContain('private endpoint');
        expect(report).toHaveBeenCalledWith(expect.objectContaining({code: 'ECONNREFUSED', stage: 'scan', result: 'failure'}));
        await vi.advanceTimersByTimeAsync(15000); expect(recover).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30000); expect(recover).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(60000); expect(recover).toHaveBeenCalledTimes(4);
        recover.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(60000); expect(recover).toHaveBeenCalledTimes(5);
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({stage: 'scan', result: 'success'}));
        await close(); await vi.advanceTimersByTimeAsync(120000); expect(recover).toHaveBeenCalledTimes(5);
        expect(vi.getTimerCount()).toBe(0);
    } finally {await close(); vi.useRealTimers();}
});

it('shares overlapping scans and waits for recovery before closing', async () => {
    let finish!: () => void;
    const recover = vi.fn(() => new Promise<void>(resolve => {finish = resolve;}));
    const close = await attachProjectDraftRecovery({recover, submitted: vi.fn()}, {onGlobalEvent: () => vi.fn()} as any,
        false, {periodic: true, report: vi.fn()});
    const first = close.recover(); expect(close.recover()).toBe(first);
    await Promise.resolve(); expect(recover).toHaveBeenCalledOnce();
    let closed = false; const closing = close().then(() => {closed = true;});
    await Promise.resolve(); expect(closed).toBe(false);
    finish(); await closing; expect(closed).toBe(true);
    await close.recover(); expect(recover).toHaveBeenCalledOnce();
});

it('continues other projects while one Cell is stalled and preserves its recovery failure', async () => {
    let reject!: (error: unknown) => void;
    const stalled = new Promise<void>((_resolve, fail) => {reject = fail;});
    const service = new ProjectDraftService(() => {throw new Error('unused');}, {} as any, async () => ['offline', 'healthy']);
    const reconcile = vi.spyOn(service, 'reconcile').mockImplementation(id => id === 'offline' ? stalled : Promise.resolve());
    const deferred = vi.fn(), scan = service.recover(undefined, undefined, deferred);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith('healthy', undefined, undefined));
    const failure = Object.assign(new Error('offline'), {code: 'ECONNREFUSED'});
    reject(failure); await expect(scan).rejects.toBeInstanceOf(AggregateError);
    expect(deferred).toHaveBeenCalledExactlyOnceWith('offline', failure);
});

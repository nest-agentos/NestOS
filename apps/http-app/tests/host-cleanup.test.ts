import {afterEach, expect, it, vi} from 'vitest';
import {closeHostResources, namedCleanup} from '../../node-host/src/runtime/host-runtime';
import {shutdownDeadline,traceHostCleanup} from '../../node-host/src/runtime/host-cleanup';
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});
it('identifies nested cleanup stages and continues releasing resources after errors without logging bodies', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => {}), released = vi.fn();
    await expect(traceHostCleanup('host.close', () => closeHostResources([
        namedCleanup('lock.release', released), namedCleanup('runtime.dispose', async () => {throw Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'});}),
    ]))).rejects.toThrow('Node host cleanup failed');
    const logs = output.mock.calls.map(row => JSON.parse(row[1] as string));
    expect(logs).toContainEqual(expect.objectContaining({stage: 'host.close/runtime.dispose', result: 'failure', code: 'EIO'}));
    expect(logs).toContainEqual(expect.objectContaining({stage: 'host.close/lock.release', result: 'success'}));
    expect(new Set(logs.map(row => row.operationId)).size).toBe(1); expect(JSON.stringify(logs)).not.toContain('PRIVATE_BODY'); expect(released).toHaveBeenCalledOnce();
});
it('reports the pending stage while awaiting an unfinished cleanup operation', async () => {
    vi.useFakeTimers(); const output = vi.spyOn(console, 'info').mockImplementation(() => {});
    let finish!: () => void;
    const work = traceHostCleanup('views.close', () => new Promise<void>(resolve => {finish = resolve;}));
    await vi.advanceTimersByTimeAsync(5000);
    expect(output.mock.calls.map(row => JSON.parse(row[1] as string))).toContainEqual(expect.objectContaining({stage: 'views.close', result: 'waiting', durationMs: 5000}));
    finish(); await work; expect(vi.getTimerCount()).toBe(0);
});

it('forces shutdown after fifteen seconds and permits cancelling an unused watchdog',async()=>{
 vi.useFakeTimers();const output=vi.spyOn(console,'info').mockImplementation(()=>{}),exit=vi.fn();
 const cancel=shutdownDeadline('shutdown-request',15000,exit);await vi.advanceTimersByTimeAsync(14999);expect(exit).not.toHaveBeenCalled();
 await vi.advanceTimersByTimeAsync(1);expect(exit).toHaveBeenCalledExactlyOnceWith(1);
 expect(output.mock.calls.map(row=>JSON.parse(String(row[1])))).toContainEqual(expect.objectContaining({operationId:'shutdown-request',stage:'deadline',code:'HTTPD_SHUTDOWN_DEADLINE',forced:true,durationMs:15000}));cancel();
 const unused=shutdownDeadline('unused',15000,exit);unused();await vi.advanceTimersByTimeAsync(15000);expect(exit).toHaveBeenCalledOnce();
});

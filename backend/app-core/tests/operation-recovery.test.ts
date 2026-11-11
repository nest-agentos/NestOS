import {afterEach, expect, it, vi} from 'vitest';
import {recoverOperation, transientOperationFailure} from '../src/run/operation-recovery';
afterEach(() => vi.useRealTimers());
function fixture(retries = 10) {
    const rows = new Map<string, unknown>(), journal = {get: async <T>(key: string) => rows.get(key) as T | undefined,
        update: async <T>(key: string, change: (old: T | undefined) => T) => {const next = change(rows.get(key) as T | undefined); rows.set(key, next); return next;}};
    const options = {journal, key: 'original-operation', active: () => true, policy: async () => ({retries, delayMs: 1000, maxDelayMs: 30000}),
        retryable: transientOperationFailure, code: () => 'EIO', deferred: vi.fn(async () => {})};
    return {options, rows};
}
it('persists ten retries across recreated callers, backs off and reports only after exhaustion', async () => {
    vi.useFakeTimers(); const f = fixture(), work = vi.fn(async () => {throw Object.assign(new Error('PRIVATE'), {code: 'EIO'});});
    await recoverOperation(f.options, work); expect(f.options.deferred).toHaveBeenCalledTimes(1);
    await recoverOperation({...f.options}, work); expect(work).toHaveBeenCalledTimes(1);
    for (let retry = 1; retry <= 10; retry++) {
        await vi.advanceTimersByTimeAsync(30000);
        if (retry < 10) await recoverOperation({...f.options}, work);
        else await expect(recoverOperation({...f.options}, work)).rejects.toMatchObject({code: 'EIO'});
    }
    expect(work).toHaveBeenCalledTimes(11); expect(f.options.deferred).toHaveBeenCalledTimes(10);
    await expect(recoverOperation({...f.options}, work)).rejects.toMatchObject({code: 'EIO'});
    expect(work).toHaveBeenCalledTimes(11); expect(f.rows.get(f.options.key)).toMatchObject({attempt: 10, exhausted: true});
});
it('recovers the same safe phase and starts a fresh budget only after success', async () => {
    vi.useFakeTimers(); const f = fixture(); const work = vi.fn(async () => {});
    work.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'ECONNRESET'}));
    await recoverOperation(f.options, work); await vi.advanceTimersByTimeAsync(1000); await recoverOperation(f.options, work);
    expect(f.rows.get(f.options.key)).toMatchObject({attempt: 1, recovered: true});
    work.mockRejectedValueOnce(Object.assign(new Error('offline'), {code: 'EIO'})); await recoverOperation(f.options, work);
    expect(f.rows.get(f.options.key)).toMatchObject({attempt: 0}); expect(f.rows.get(f.options.key)).not.toHaveProperty('recovered');
});
it('does not retry permissions, integrity errors, protocol failures or work after stopping', async () => {
    const f = fixture();
    for (const error of [Object.assign(new Error('private'), {code: 'EACCES'}), Object.assign(new Error('private'), {code: 'EIO', remoteCode: 'STORAGE_CORRUPT'}),
        Object.assign(new Error('private'), {code: 'EIO', operation: 'protocol'})]) {
        await expect(recoverOperation(f.options, async () => {throw error;})).rejects.toBe(error);
    }
    const work = vi.fn(); await recoverOperation({...f.options, active: () => false}, work);
    expect(work).not.toHaveBeenCalled(); expect(f.options.deferred).not.toHaveBeenCalled();
});

it('defers confirmed busy admission using the existing operation identity and recovery budget',async()=>{
    vi.useFakeTimers();const f=fixture(),busy=Object.assign(Error('Busy'),{code:'EBUSY',outcome:'not-committed'});
    const work=vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(undefined);
    await recoverOperation({...f.options,code:()=> 'EBUSY'},work);
    expect(f.rows.get(f.options.key)).toMatchObject({attempt:0,code:'EBUSY',exhausted:false});
    await recoverOperation(f.options,work);expect(work).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);await recoverOperation(f.options,work);
    expect(work).toHaveBeenCalledTimes(2);expect(f.rows.get(f.options.key)).toMatchObject({recovered:true});
});

it('does not infer safe admission from a bare busy code, uncertain cleanup or partial effects',()=>{
    for(const outcome of [undefined,'unknown','partial'])expect(transientOperationFailure(Object.assign(Error('Busy'),{code:'EBUSY',outcome}))).toBe(false);
    const busy=Object.assign(Error('Busy'),{code:'EBUSY',outcome:'not-committed'});
    expect(transientOperationFailure(Object.assign(Error('Unknown'),{code:'EIO',outcome:'unknown',cause:busy}))).toBe(false);
    expect(transientOperationFailure(Object.assign(Error('Denied'),{code:'EACCES',cause:busy}))).toBe(false);
});

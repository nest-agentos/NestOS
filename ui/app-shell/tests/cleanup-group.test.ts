import {afterEach,expect,it,vi} from 'vitest';
import {cleanupGroup} from '../src/lifecycle/cleanup-group';

afterEach(() => vi.restoreAllMocks());

it('records unavailable capabilities during recovery and continues releasing local resources', async () => {
    let recovering = false;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanup = cleanupGroup(() => recovering), released = vi.fn();
    cleanup.own(released);
    cleanup.own(() => {throw Object.assign(new Error('PRIVATE_BODY'), {code: 'ECAPABILITY', requestId: 'request-1'});});
    cleanup.own(() => {throw Object.assign(new Error('PRIVATE_BODY'), {code: 'ECAPABILITY', requestId: 'request-1'});});
    recovering = true;await cleanup.close();await cleanup.close();
    expect(released).toHaveBeenCalledOnce();expect(error).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledExactlyOnceWith('[Shell] Workspace cleanup unavailable during recovery', expect.objectContaining({
        operation: 'workspace.cleanup', stage: 'release', result: 'unavailable', code: 'ECAPABILITY', requestId: 'request-1',
        operationId: expect.any(String), durationMs: expect.any(Number), count: 2,
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE_BODY');
});

it.each([false,true])('preserves real cleanup errors when recovering=%s', async recovering => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cleanup = cleanupGroup(() => recovering);
    cleanup.own(() => {throw Object.assign(new Error('PRIVATE_BODY'), {code: 'EIO'});});
    await cleanup.close();expect(warning).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[Shell] Workspace cleanup failed', expect.objectContaining({result: 'failure', code: 'EIO'}));
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE_BODY');
});

it('does not downgrade capability failures during normal workspace cleanup', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}), cleanup = cleanupGroup();
    cleanup.own(() => {throw Object.assign(new Error('unsupported capability'), {code: 'ECAPABILITY'});});
    await cleanup.close();expect(error).toHaveBeenCalledWith('[Shell] Workspace cleanup failed', expect.objectContaining({result: 'failure', code: 'ECAPABILITY'}));
});

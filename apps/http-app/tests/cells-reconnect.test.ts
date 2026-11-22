import {expect, it, vi} from 'vitest';
import type {ProjectRemoteMountPort} from '@nestos/app-contracts/services';
import {startCellsReconnect} from '../../node-host/src/runtime/cells-reconnect';

it('retries an unavailable Cell and cancels the in-flight check on shutdown', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const checkConnection = vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce((_id, options: {signal: AbortSignal}) => new Promise<void>(resolve => {
            signal = options.signal;
            signal.addEventListener('abort', () => resolve(), {once: true});
        }));
    const remote = {
        connections: () => [{id: 'cell'}, {id: 'dav', protocol: 'webdav'}],
        connectionStatus: () => 'offline',
        checkConnection,
    } as unknown as ProjectRemoteMountPort;
    const stop = startCellsReconnect(remote);
    try {
        await vi.advanceTimersByTimeAsync(4999);
        expect(checkConnection).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(checkConnection).toHaveBeenCalledExactlyOnceWith('cell', expect.objectContaining({timeoutMs: 3000}));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(checkConnection).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(checkConnection).toHaveBeenCalledTimes(2);
        await stop();
        expect(signal?.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(checkConnection).toHaveBeenCalledTimes(2);
    } finally {
        await stop();
        vi.useRealTimers();
    }
});

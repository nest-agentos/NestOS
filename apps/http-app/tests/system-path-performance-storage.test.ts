import {expect, it} from 'vitest';
import {instrumentStorage, type StorageEvent} from './system-path-performance-storage';

it('counts port calls, returned entries and bytes without recording names or contents', async () => {
    const events: StorageEvent[] = [];
    const inner = {readFile:async (_path: string) => new ArrayBuffer(12), readDir:async (_path: string) => ['one','two'],
        writeFile:async (_path: string,_data: ArrayBuffer) => {}};
    const wrapped = instrumentStorage(inner,'fs',events);
    await wrapped.readFile('/private/path'); await wrapped.readDir('/private/path'); await wrapped.writeFile('/private/path',new ArrayBuffer(7));
    expect(events.map(({method,bytes,returned,bytesWritten}) => ({method,bytes,returned,bytesWritten}))).toEqual([
        {method:'readFile',bytes:12,returned:0,bytesWritten:0}, {method:'readDir',bytes:0,returned:2,bytesWritten:0},
        {method:'writeFile',bytes:0,returned:0,bytesWritten:7},
    ]);
    expect(JSON.stringify(events)).not.toContain('/private/path');
});
it('counts transaction-bound operations', async () => {
    const events: StorageEvent[] = [];
    const db = {readTransaction:async (fn: (tx: {list:() => Promise<string[]>}) => Promise<unknown>) => fn({list:async () => ['x']})};
    await instrumentStorage(db,'sidecar',events).readTransaction(tx => tx.list());
    expect(events.map(event => event.method)).toEqual(['readTransaction','list']);
    expect(events[1].returned).toBe(1);
});

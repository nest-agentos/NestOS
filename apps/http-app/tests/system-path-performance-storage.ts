export interface StorageEvent {timestamp: number; source: 'fs' | 'sidecar'; method: string; returned: number; bytes: number; bytesWritten: number}

/** Count host port operations and returned entries, not physical disk or SQLite scans. */
export function instrumentStorage<T extends object>(target: T, source: StorageEvent['source'], events: StorageEvent[]): T {
    return new Proxy(target, {get(instance, key) {
        const value = Reflect.get(instance, key, instance);
        if (typeof value !== 'function' || typeof key !== 'string') return value;
        return (...args: unknown[]) => {
            const event: StorageEvent = {timestamp:Date.now(),source,method:key,returned:0,bytes:0,bytesWritten:0}; events.push(event);
            if (source === 'fs' && (key === 'writeFile' || key === 'appendFile') && args[1] instanceof ArrayBuffer) event.bytesWritten = args[1].byteLength;
            if ((key === 'transaction' || key === 'readTransaction') && typeof args[0] === 'function') {
                const callback = args[0] as (transaction: object) => unknown;
                args[0] = (transaction: object) => callback(instrumentStorage(transaction,source,events));
            }
            const result = value.apply(instance,args);
            return Promise.resolve(result).then(output => {
                if (Array.isArray(output)) event.returned = output.length;
                else if (output instanceof ArrayBuffer) event.bytes = output.byteLength;
                else if (key === 'listRecordFieldsPage' && output && typeof output === 'object' && Array.isArray((output as {rows?: unknown}).rows)) event.returned = (output as {rows: unknown[]}).rows.length;
                else if (key === 'getRecordFields' && output && typeof output === 'object') event.returned = Object.keys(output).length;
                return output;
            });
        };
    }});
}

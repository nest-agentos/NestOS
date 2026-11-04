import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {storageStartupError} from './startup-error';

/** OS-backed SQLite locks survive neither crashes nor process exits. */
export async function acquireHostLock(directory: string): Promise<() => void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const moduleName = 'node:sqlite';
    const { DatabaseSync } = await import(moduleName) as { DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void } };
    const file = path.join(directory, 'httpd-host-lock.sqlite'), started = performance.now();
    let database: InstanceType<typeof DatabaseSync> | undefined;
    try {
        database = new DatabaseSync(file);
        database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    } catch (error) {
        try {database?.close();} catch { /* Preserve the acquisition failure. */ }
        throw await storageStartupError(error, file, 'storage.host-lock.acquire', started, true);
    }
    return () => database!.close();
}

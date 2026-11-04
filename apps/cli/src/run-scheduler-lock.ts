import path from 'node:path';

interface LockDatabase { exec(sql: string): void; close(): void; }

/** Hold a separate SQLite write lock for the lifetime of a CLI scheduler. */
export async function acquireRunSchedulerLock(runDirectory: string): Promise<() => void> {
    const moduleName = 'node:sqlite';
    const sqlite = await import(moduleName) as { DatabaseSync: new (file: string) => LockDatabase };
    const db = new sqlite.DatabaseSync(path.join(runDirectory, 'scheduler.lock.sqlite'));
    try {
        db.exec('PRAGMA busy_timeout = 0');
        db.exec('BEGIN IMMEDIATE');
    } catch (error) {
        db.close();
        if ((error as { errcode?: number }).errcode === 5) {
            throw new Error('Run already has an active scheduler');
        }
        throw error;
    }
    let closed = false;
    return () => {
        if (closed) return;
        db.close();
        closed = true;
    };
}

import path from 'node:path';
import {stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
interface DatabaseSync {
    prepare(sql: string): {all(...args: unknown[]): Record<string, unknown>[]; get(): Record<string, unknown> | undefined};
    exec(sql: string): void;
    close(): void;
}
const sqliteModule = 'node:sqlite';
const {DatabaseSync} = await import(sqliteModule) as {DatabaseSync: new (file: string) => DatabaseSync};
import {createVFS, type IFileSystem} from '@nestos/vfs-core';
import {openLocalFSBackend} from '@nestos/vfsdriver-local';
import {SeqFileKernelStore} from '@nestos/durable-kernel';
import {SeqTwinStore} from '@nestos/app-core';
import {acquireHostLock, NodeSqliteSidecarDb} from '@nestos/node-host/storage';

const keepVersions = 20;
const minimumAgeMs = 7 * 24 * 3600 * 1000;
const operationId = randomUUID();
let stage = 'arguments';

async function compactRuns(db: DatabaseSync, fs: IFileSystem) {
    const twins = db.prepare("SELECT path,value FROM records WHERE path GLOB '/var/lib/digital-twin/*/authority.seq' AND field='__vfs_seq__:twin'").all();
    let runs = 0, versions = 0;
    for (const row of twins) {
        const binding = JSON.parse(JSON.parse(String(row.value)));
        const root = path.posix.dirname(String(row.path));
        if (root !== '/var/lib/digital-twin/' + binding.twinId) throw new Error('TWIN_MAINTENANCE_IDENTITY_MISMATCH');
        const store = await SeqTwinStore.open(fs, binding.twinId, binding.ownerId);
        const heads = db.prepare("SELECT field FROM records WHERE path=? AND field GLOB '__vfs_seq__:head/scan-run/*'").all(root + '/knowledge.seq');
        for (const head of heads) {
            const id = decodeURIComponent(String(head.field).slice('__vfs_seq__:head/scan-run/'.length));
            const changed = await store.compactScanRun(id);
            if (changed) {runs++; versions += changed;}
        }
    }
    return {runs, versions};
}

async function compactTasks(db: DatabaseSync, fs: IFileSystem) {
    const cutoff = Date.now() - minimumAgeMs;
    const rows = db.prepare(`WITH candidates AS (
        SELECT path,json_extract(value,'$') AS body FROM records
        WHERE path GLOB '/var/lib/sessions/*/tasks/*/task.seq' AND field='__vfs_seq__:record')
        SELECT path,json_extract(body,'$.id') AS id FROM candidates
        WHERE json_extract(body,'$.status') IN ('succeeded','failed','cancelled')
        AND json_extract(body,'$.updatedAt') <= ? AND json_extract(body,'$.version') >= ?`).all(cutoff, keepVersions);
    let tasks = 0, snapshots = 0;
    const kernel = new SeqFileKernelStore({fs, rootPath: '/'}, async () => {throw new Error('UNEXPECTED_STORAGE_RESOLUTION');});
    for (const row of rows) {
        const rootPath = path.posix.dirname(path.posix.dirname(path.posix.dirname(String(row.path))));
        const id = String(row.id);
        if (id.includes('/') || String(row.path) !== rootPath + '/tasks/' + id + '/task.seq') throw new Error('TASK_STORAGE_IDENTITY_MISMATCH');
        const {removed} = await kernel.compactTaskHistory({fs, rootPath}, id, {keepVersions});
        if (removed) {tasks++; snapshots += removed;}
    }
    return {tasks, snapshots};
}

async function run() {
    if (process.argv.length !== 3) throw new Error('Expected the user bundle .nestos directory');
    const internal = path.resolve(process.argv[2]), dbFile = path.join(internal, 'meta/index.db'), rootDir = path.join(internal, 'state');
    await stat(dbFile); await stat(rootDir);
    stage = 'lock';
    const release = await acquireHostLock(path.join(internal, 'host-lock'));
    try {
        const backend = await openLocalFSBackend({rootDir, sidecarDir: path.dirname(dbFile), createDb: NodeSqliteSidecarDb.open});
        try {
            const {manager} = await createVFS({rootBackend: backend});
            try {await maintain(dbFile, await manager.openFileSystem('/'));} finally {await manager.dispose();}
        } finally {await backend.close();}
    } finally {release();}
}

async function maintain(dbFile: string, fs: IFileSystem) {
    const db = new DatabaseSync(dbFile), started = Date.now();
    try {
        stage = 'scan-history'; const runs = await compactRuns(db, fs);
        stage = 'task-history'; const tasks = await compactTasks(db, fs);
        stage = 'vacuum';
        if (runs.versions || tasks.snapshots || Number(db.prepare('PRAGMA freelist_count').get()?.freelist_count)) db.exec('VACUUM');
        stage = 'verify';
        if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLITE_INTEGRITY_CHECK_FAILED');
        console.info({operation: 'storage.compact', operationId, stage, result: 'success', ...runs, ...tasks, durationMs: Date.now() - started});
    } finally {db.close();}
}
run().catch(error => {console.error({operation: 'storage.compact', operationId, stage, result: 'failure', error: error.message}); process.exitCode = 1;});

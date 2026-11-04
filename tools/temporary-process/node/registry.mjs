import {constants} from 'node:fs';
import {mkdir, open, rename, readdir, lstat, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {alive, failure, stopOwned} from './identity.mjs';
export const defaultDirectory = () => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'nestos/temporary-process');
export async function prepareDirectory(directory) {
    directory = resolve(directory); await mkdir(directory, {recursive: true, mode: 0o700});
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw failure('TEMP_PROCESS_REGISTRY_PERMISSIONS');
    return directory;
}
export const recordPath = (directory, id) => {if (!/^[\w-]{1,128}$/.test(id)) throw failure('TEMP_PROCESS_INVALID_ID'); return join(directory, id + '.json');};
export async function createRecord(directory, record) {
    const file = await open(recordPath(directory, record.id), 'wx', 0o600);
    try {await file.writeFile(JSON.stringify(record)); await file.sync();} finally {await file.close();}
    const dir = await open(directory, 'r'); try {await dir.sync();} finally {await dir.close();}
}
export async function save(directory, record) {
    const target = recordPath(directory, record.id), temporary = target + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {await file.writeFile(JSON.stringify(record)); await file.sync();} finally {await file.close();}
    try {await rename(temporary, target); const dir = await open(directory, 'r'); try {await dir.sync();} finally {await dir.close();}}
    finally {await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;});}
}
export async function load(directory, id) {
    const file = await open(recordPath(directory, id), constants.O_RDONLY | constants.O_NOFOLLOW); let record;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 65536 || stat.mode & 0o077) throw failure('TEMP_PROCESS_RECORD_INVALID');
        try {record = JSON.parse(await file.readFile('utf8'));} catch (error) {if (error instanceof SyntaxError) throw failure('TEMP_PROCESS_RECORD_INVALID'); throw error;}
    } finally {await file.close();}
    if (record.schema !== 'temporary-process/1' || record.id !== id || !/^[\w-]{1,128}$/.test(record.token) || !record.owner) throw failure('TEMP_PROCESS_RECORD_INVALID');
    return record;
}
export function emit(log, event) {try {const pending = log?.(event); pending?.catch?.(() => {});} catch { /* Diagnostics never own process cleanup. */ }}
export async function recover(directory = defaultDirectory(), log = () => {}) {
    if (process.platform !== 'linux') throw failure('TEMP_PROCESS_UNSUPPORTED');
    directory = await prepareDirectory(directory); const results = [];
    for (const name of await readdir(directory)) if (name.endsWith('.json')) {
        const id = name.slice(0, -5), started = Date.now();
        try {
            const record = await load(directory, id); if (record.phase === 'closed') continue;
            const ownerAlive = await alive(record.owner);
            if (record.phase !== 'unknown' && Date.now() < record.expiresAt && ownerAlive) {results.push({id, state: 'active'}); continue;}
            const reason = ownerAlive ? record.phase === 'unknown' ? 'cleanup-retry' : 'deadline' : 'owner-lost';
            await stopOwned(record);
            // Do not overwrite a guardian's newer completion receipt.
            const current = await load(directory, id);
            if (current.phase !== 'closed') await save(directory, {...current, phase: 'closed', reason, closedAt: Date.now()});
            results.push({id, state: 'recovered'}); emit(log, {operation: 'temporary-process.recover', operationId: id, stage: 'reap', result: 'success', durationMs: Date.now() - started});
        } catch (error) {results.push({id, state: 'unknown', code: error.code ?? 'TEMP_PROCESS_RECOVERY_FAILED'}); emit(log, {operation: 'temporary-process.recover', operationId: id, stage: 'reap', result: 'failure', code: error.code ?? 'TEMP_PROCESS_RECOVERY_FAILED', durationMs: Date.now() - started});}
    }
    return results;
}

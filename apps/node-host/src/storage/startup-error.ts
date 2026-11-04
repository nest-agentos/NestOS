import {randomUUID} from 'node:crypto';
import {readdir, readlink, realpath} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

export interface StorageStartupDiagnostic {
    operationId: string; stage: string; code: string; database: string; durationMs: number;
    sqliteCode?: number; causeCode?: string; openByPids: number[]; processLookup: string; hint: string;
}
export function sqliteBusy(error: unknown): boolean {
    const value = error as {errcode?: number; code?: string};
    return [5, 6].includes((value?.errcode ?? -1) & 255) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(value?.code ?? '');
}
export async function storageStartupError(error: unknown, file: string, stage: string, started: number, lock = false): Promise<Error> {
    const busy = sqliteBusy(error), value = error as {errcode?: number; code?: string};
    const code = value?.code === 'DATABASE_SCHEMA_INCOMPATIBLE' ? value.code : busy ? lock ? 'HOST_LOCK_BUSY' : 'DATABASE_BUSY' : lock ? 'HOST_LOCK_FAILED' : 'DATABASE_OPEN_FAILED';
    const lookup = busy ? await openProcesses(file) : {pids: [], state: 'not-needed'};
    const hint = code === 'DATABASE_SCHEMA_INCOMPATIBLE' ? 'Filesystem database version incompatible; use a compatible host or supported migration.' : busy ? 'another application host or database connection may still be active; inspect the listed PIDs and wait for shutdown. Do not delete database files.'
        : 'Check the database path, permissions and storage availability; the original failure is preserved as the cause.';
    const diagnostic: StorageStartupDiagnostic = {operationId: randomUUID(), stage, code, database: file, durationMs: Math.round(performance.now() - started),
        sqliteCode: Number.isInteger(value?.errcode) ? value.errcode : undefined, causeCode: safeStartupCode(value?.code), openByPids: lookup.pids, processLookup: lookup.state, hint};
    return Object.assign(new Error(`${stage}: ${code}; database=${file}. ${hint}`, {cause: error}), {code, startupDiagnostic: diagnostic});
}
export function safeStartupCode(value: unknown): string | undefined {return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : undefined;}
/** Open descriptors are diagnostic candidates, not proof that a particular process owns a write lock. */
async function openProcesses(file: string): Promise<{pids: number[]; state: string}> {
    if (process.platform !== 'linux') return {pids: [], state: 'unsupported'};
    const pids: number[] = [], deadline = performance.now() + 300;
    try {
        const canonical = await realpath(file), candidates = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
        for (const pid of candidates) {
            if (performance.now() > deadline) return {pids, state: 'partial'};
            try {
                const directory = `/proc/${pid}/fd`, descriptors = (await readdir(directory)).slice(0, 1024);
                const paths = await Promise.all(descriptors.map(fd => readlink(`${directory}/${fd}`).catch(() => '')));
                if (paths.includes(canonical)) pids.push(Number(pid));
            } catch { /* Other users' descriptors may be inaccessible. */ }
        }
        return {pids, state: pids.length ? 'found' : 'not-found'};
    } catch {return {pids, state: 'unavailable'};}
}

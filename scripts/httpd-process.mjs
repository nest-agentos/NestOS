import {mkdir, readFile, writeFile, rename, rm, readdir, realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
let bootId, writeLifecycle;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hints = {
    HTTPD_SAFE_STOP_PENDING: 'Waiting for a safe checkpoint; process and locks are retained. Retry or increase --timeout-ms. Use --force only to allow interruption.',
    HTTPD_CONTROL_BUSY: 'Another start, stop or restart is in progress; retry after it finishes.',
    HTTPD_STOP_UNCONFIRMED: 'Process exit could not be confirmed; a replacement host will not be started.',
};
const failure = code => Object.assign(new Error(code + (hints[code] ? ': ' + hints[code] : '')), {code});
const stateFile = (root, mode) => path.join(root, 'release/httpd-processes', mode + '.json');
export function setLifecycleLog(write) {writeLifecycle = write;}
export function lifecycleLog(event) {
    const line = '[HTTPProcess] ' + JSON.stringify({operation: 'http.process', ...event});
    console.info(line); writeLifecycle?.(Buffer.from(line + '\n'));
}
export async function withHttpdControl(root, run) {
    const directory = path.dirname(stateFile(root, 'release')); await mkdir(directory, {recursive: true, mode: 0o700});
    const db = new DatabaseSync(path.join(directory, 'control.sqlite'));
    try {try {db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');} catch (error) {throw failure(error.errcode === 5 ? 'HTTPD_CONTROL_BUSY' : 'HTTPD_CONTROL_FAILED');} return await run();}
    finally {db.close();}
}
/** Process birth identity prevents a stale record from targeting a reused PID. */
export async function processIdentity(pid, details = true) {
    if (!Number.isSafeInteger(pid) || pid < 2) return undefined;
    try {
        if (process.platform !== 'linux') {
            const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore']}).trim();
            return started ? {pid, birth: started} : undefined;
        }
        bootId ??= (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (fields.length < 20) throw failure('HTTPD_PROCESS_STATE_UNKNOWN');
        // A dead main thread can still have live worker threads holding shared file descriptors.
        if (['Z', 'X'].includes(fields[0]) && (await readdir(`/proc/${pid}/task`)).length <= 1) return undefined;
        const argv = details ? (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean) : undefined;
        return {pid, birth: bootId + ':' + fields[19], ...(argv ? {argv} : {})};
    } catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code) || error.status === 1) return undefined; throw error;}
}
function allowedEntry(root, mode, entry, releases) {
    if (mode === 'dev') return entry === path.join(root, 'apps/http-app/src/server/main.ts');
    const relative = path.relative(releases, entry).split(path.sep);
    return relative.length === 3 && relative[0] !== '..' && relative[1] === 'server' && relative[2] === 'main.js';
}
async function matches(record) {
    const current = await processIdentity(record.pid, false);
    return current?.birth === record.birth && (!current.argv || current.argv.includes(record.entry));
}
async function readRecord(root, mode, releases) {
    try {
        const row = JSON.parse(await readFile(stateFile(root, mode), 'utf8'));
        if (!row || row.schema !== 1 || row.mode !== mode || !Number.isSafeInteger(row.pid) || typeof row.birth !== 'string' || typeof row.entry !== 'string'
            || typeof row.instanceId !== 'string' || !Array.isArray(row.args) || row.args.some(arg => typeof arg !== 'string')
            || !allowedEntry(root, mode, row.entry, releases)) throw failure('HTTPD_PROCESS_RECORD_INVALID');
        const current = await processIdentity(row.pid);
        return current?.birth === row.birth && (!current.argv || current.argv.includes(row.entry)) ? row : undefined;
    } catch (error) {if (error.code === 'ENOENT') return undefined; if (error instanceof SyntaxError) throw failure('HTTPD_PROCESS_RECORD_INVALID'); throw error;}
}
/** Linux fallback finds launchers predating the registry; it never identifies hosts by port. */
async function legacyHosts(root, mode, releases) {
    if (process.platform !== 'linux') return [];
    const rows = [];
    for (const name of await readdir('/proc')) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        let command;
        try {command = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean);} catch {continue;}
        if (!command.some(arg => arg.endsWith('/server/main.js') || arg.endsWith('/server/main.ts'))) continue;
        const current = await processIdentity(Number(name)); if (!current) continue;
        const entry = current.argv.find(arg => allowedEntry(root, mode, arg, releases)); if (!entry) continue;
        const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => '');
        const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        const owner = await processIdentity(parent);
        if (!owner?.argv) continue;
        const ownerCwd = await realpath(`/proc/${parent}/cwd`).catch(() => '');
        if (!ownerCwd || !owner.argv.some(arg => path.resolve(ownerCwd, arg) === path.join(root, 'scripts/httpd.mjs'))) continue;
        const offset = current.argv.indexOf(entry);
        rows.push({...current, mode, entry, args: current.argv.slice(offset + 1)});
    }
    return rows;
}
export async function runningHttpd(root, mode, releases) {
    const registered = await readRecord(root, mode, releases);
    return registered ? [registered] : legacyHosts(root, mode, releases);
}
export async function registerHttpd(root, mode, pid, entry, args) {
    const identity = await processIdentity(pid); if (!identity) throw failure('HTTPD_EXITED_DURING_START');
    const row = {schema: 1, pid, birth: identity.birth, mode, entry, args, instanceId: randomUUID()};
    const file = stateFile(root, mode), temporary = file + '.' + row.instanceId;
    await writeFile(temporary, JSON.stringify(row) + '\n', {mode: 0o600, flag: 'wx'}); await rename(temporary, file);
    return row;
}
export async function unregisterHttpd(root, mode, record) {
    try {const current = JSON.parse(await readFile(stateFile(root, mode), 'utf8'));
        if (current.instanceId === record.instanceId && current.pid === record.pid) await rm(stateFile(root, mode));
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
}
async function waitForExit(record, milliseconds) {
    const deadline = Date.now() + milliseconds;
    do {if (!await matches(record)) return true; await delay(Math.min(100, Math.max(1, deadline - Date.now())));} while (Date.now() < deadline);
    return !await matches(record);
}
async function signalHost(record, signal) {
    if (!await matches(record)) return;
    try {process.kill(record.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
}
export async function stopHttpd(root, mode, releases, options = {}) {
    const operationId = randomUUID(), started = Date.now(), timeoutMs = options.timeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000) throw failure('HTTPD_INVALID_STOP_TIMEOUT');
    const hosts = options.owned ? [options.owned] : await runningHttpd(root, mode, releases);
    if (!hosts.length) {lifecycleLog({operationId, stage: 'stop', result: 'already-stopped', durationMs: Date.now() - started}); return;}
    const results = await Promise.allSettled(hosts.map(async record => {
        lifecycleLog({operationId, pid: record.pid, stage: 'stop.signal', result: 'started', signal: 'SIGTERM'});
        await signalHost(record, 'SIGTERM');
        let forced = false;
        if (!await waitForExit(record, timeoutMs)) {
            if (!options.force) {
                lifecycleLog({operationId, pid: record.pid, stage: 'stop.safe-point', result: 'waiting', code: 'HTTPD_SAFE_STOP_PENDING', durationMs: Date.now() - started});
                throw failure('HTTPD_SAFE_STOP_PENDING');
            }
            forced = true;
            lifecycleLog({operationId, pid: record.pid, stage: 'stop.escalate', result: 'waiting', code: 'HTTPD_GRACEFUL_STOP_TIMEOUT'});
            await signalHost(record, 'SIGKILL');
            if (!await waitForExit(record, 5000)) throw failure('HTTPD_STOP_UNCONFIRMED');
        }
        if (record.instanceId && !options.owned) await unregisterHttpd(root, mode, record);
        lifecycleLog({operationId, pid: record.pid, stage: 'stop', result: 'success', forced, durationMs: Date.now() - started});
        return record;
    }));
    const failed = results.find(row => row.status === 'rejected'); if (failed) throw failed.reason;
    return results[0]?.value;
}

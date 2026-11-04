import {readFile, readdir} from 'node:fs/promises';
const missing = error => error.code === 'ENOENT' || error.code === 'ESRCH';
export async function identity(pid) {
    if (!Number.isSafeInteger(pid) || pid < 2) throw failure('TEMP_PROCESS_INVALID_IDENTITY');
    try {
        const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return {pid, start: fields[19], boot: boot.trim(), group: Number(fields[2]), session: Number(fields[3]), state: fields[0]};
    } catch (error) {if (missing(error)) return undefined; throw error;}
}
export function same(a, b) {return !!a && !!b && a.pid === b.pid && a.start === b.start && a.boot === b.boot;}
export async function alive(expected) {const actual = await identity(expected.pid); return same(actual, expected) && actual.state !== 'Z';}
export function failure(code) {return Object.assign(new Error(code), {code});}
export function cleanupFailure(errors) {return Object.assign(new AggregateError(errors, 'TEMP_PROCESS_CLEANUP_UNCONFIRMED'), {code: 'TEMP_PROCESS_CLEANUP_UNCONFIRMED'});}
async function members(group) {
    const result = [];
    for (const name of await readdir('/proc')) if (/^\d+$/.test(name) && Number(name) > 1) {
        const row = await identity(Number(name)); if (row?.group === group && row.state !== 'Z') result.push(row);
    }
    return result;
}
export async function ownedMembers(record) {
    if (!record.worker) return [];
    if (record.worker.boot !== (await identity(process.pid))?.boot) return [];
    const rows = await members(record.worker.pid);
    if (!rows.length) return [];
    if (rows.some(row => row.boot !== record.worker.boot || row.session !== record.worker.session || BigInt(row.start) < BigInt(record.worker.start))) throw failure('TEMP_PROCESS_IDENTITY_MISMATCH');
    let proven = false;
    for (const row of rows) {
        try {const env = await readFile(`/proc/${row.pid}/environ`); if (env.toString().split('\0').includes(`NESTOS_TEMPORARY_PROCESS_TOKEN=${record.token}`)) proven = true;}
        catch (error) {if (!missing(error)) throw error;}
    }
    if (!proven) {if (!(await members(record.worker.pid)).length) return []; throw failure('TEMP_PROCESS_OWNERSHIP_UNKNOWN');}
    return rows;
}
export async function stopOwned(record, graceMs = 1000) {
    if (!(await ownedMembers(record)).length) return;
    signalGroup(record.worker.pid, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {if (!(await ownedMembers(record)).length) return; await new Promise(resolve => setTimeout(resolve, 30));}
    if ((await ownedMembers(record)).length) signalGroup(record.worker.pid, 'SIGKILL');
    for (let n = 0; n < 50; n++) {if (!(await ownedMembers(record)).length) return; await new Promise(resolve => setTimeout(resolve, 30));}
    throw failure('TEMP_PROCESS_CLEANUP_UNCONFIRMED');
}
function signalGroup(pid, signal) {try {process.kill(-pid, signal);} catch (error) {if (!missing(error)) throw error;}}

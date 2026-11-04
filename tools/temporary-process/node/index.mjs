import {fork} from 'node:child_process';
import {constants} from 'node:fs';
import {open, realpath} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {identity, failure, cleanupFailure, stopOwned} from './identity.mjs';
import {defaultDirectory, prepareDirectory, createRecord, save, load, emit} from './registry.mjs';
export {recover} from './registry.mjs';
export async function temporaryScope(options = {}) {
    if (process.platform !== 'linux') throw failure('TEMP_PROCESS_UNSUPPORTED');
    const directory = await prepareDirectory(options.directory ?? defaultDirectory()), owner = await identity(process.pid);
    const scopeId = options.scopeId ?? randomUUID(), handles = new Set(), admissions = new Set(); let closed = false, closing;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/.test(scopeId)) throw failure('TEMP_PROCESS_INVALID_SCOPE');
    const scope = {
        start(command, args = [], settings = {}) {
            const pending = start(command, args, settings); admissions.add(pending);
            void pending.finally(() => admissions.delete(pending)).catch(() => {}); return pending;
        },
        close() {return closing ??= close();},
    };
    async function start(command, args, settings) {
            if (closed || options.signal?.aborted) throw failure('TEMP_PROCESS_SCOPE_CLOSED');
            const handle = await launch({directory, owner, scopeId, command, args, settings, log: options.log}, handles);
            if (closed || options.signal?.aborted) {await handle.stop(); throw failure('TEMP_PROCESS_SCOPE_CLOSED');}
            return handle;
    }
    async function close() {closed = true; await Promise.allSettled([...admissions]); options.signal?.removeEventListener('abort', aborted); const results = await Promise.allSettled([...handles].map(handle => handle.stop())); const failures = results.filter(row => row.status === 'rejected'); if (failures.length) throw cleanupFailure(failures.map(row => row.reason));}
    const aborted = () => {void scope.close().catch(error => emit(options.log, {operation: 'temporary-process', operationId: scopeId, stage: 'abort', result: 'failure', code: error.code ?? 'TEMP_PROCESS_CLEANUP_UNCONFIRMED'}));};
    options.signal?.addEventListener('abort', aborted, {once: true}); return scope;
}
export async function withTemporaryScope(options, run) {
    const scope = await temporaryScope(options);
    let primaryError;
    try {return await run(scope);} catch (error) {primaryError = error; throw error;}
    finally {try {await scope.close();} catch (error) {if (primaryError) throw cleanupFailure([primaryError, error]); throw error;}}
}
async function launch(input, handles) {
    const {directory, owner, scopeId, command, args, settings, log} = input, timeoutMs = settings.timeoutMs ?? 600000;
    if (typeof command !== 'string' || !command || !Array.isArray(args) || args.some(arg => typeof arg !== 'string') || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3600000) throw failure('TEMP_PROCESS_INVALID_REQUEST');
    const cwd = await realpath(resolve(settings.cwd ?? process.cwd()));
    const record = {schema: 'temporary-process/1', cwd, id: settings.resourceId ?? randomUUID(), token: randomUUID(), scopeId, owner, phase: 'prepared', createdAt: Date.now(), expiresAt: Date.now() + timeoutMs};
    await createRecord(directory, record);
    const guardian = fork(fileURLToPath(new URL('guardian.mjs', import.meta.url)), [], {detached: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    const handle = connect(guardian, directory, record, log); handles.add(handle);
    guardian.send({type: 'start', directory, record, timeoutMs, command, args, cwd}, error => {if (error) guardian.kill('SIGTERM');});
    try {await handle.ready; return handle;} catch (error) {await handle.stop(); throw error;}
    finally {void handle.result.then(() => handles.delete(handle), () => {});}
}
function connect(guardian, directory, record, log = () => {}) {
    let complete, fail, ready, unready, ended = false;
    const result = new Promise((resolve, reject) => {complete = resolve; fail = reject;}), readiness = new Promise((resolve, reject) => {ready = resolve; unready = reject;});
    void result.catch(() => {}); void readiness.catch(() => {});
    const finished = (error, receipt) => {if (ended) return; ended = true; clearTimeout(startTimer); if (error) {unready(error); fail(error);} else {unready(failure(receipt.code ?? 'TEMP_PROCESS_ENDED_BEFORE_READY')); complete(receipt);} emit(log, {operation: 'temporary-process', operationId: record.id, scopeId: record.scopeId, stage: 'release', result: error ? 'failure' : 'success', code: error?.code, durationMs: Date.now() - record.createdAt});};
    const startTimer = setTimeout(() => {if (guardian.connected) guardian.send({type: 'stop'});}, 15000);
    guardian.on('message', message => {
        if (message.type === 'ready') {clearTimeout(startTimer); ready(); emit(log, {operation: 'temporary-process', operationId: record.id, scopeId: record.scopeId, stage: 'start', result: 'success', durationMs: Date.now() - record.createdAt});}
        if (message.type === 'closed') finished(undefined, message.result);
        if (message.type === 'failed') finished(failure(message.code));
    });
    guardian.once('error', error => {finished(failure(error.code ?? 'TEMP_PROCESS_GUARDIAN_FAILED'));});
    guardian.once('exit', () => {if (!ended) void load(directory, record.id).then(async saved => {await stopOwned(saved); await save(directory, {...saved, phase: 'closed', reason: 'guardian-lost', closedAt: Date.now()}); finished(failure('TEMP_PROCESS_GUARDIAN_LOST'));}).catch(error => finished(failure(error.code ?? 'TEMP_PROCESS_CLEANUP_UNCONFIRMED')));});
    return {id: record.id, ready: readiness, result, async stop() {if (!ended && guardian.connected) guardian.send({type: 'stop'}, () => {}); return result;}};
}

export async function processOutput(directory = defaultDirectory(), id) {
    await load(directory, id);
    const file = await open(join(directory, id + '.output.log'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {const {size} = await file.stat(), bytes = Math.min(size, 65536), buffer = Buffer.alloc(bytes);
        await file.read(buffer, 0, bytes, Math.max(0, size - bytes)); return {output: buffer.toString(), outputBytes: size, outputTruncated: size > bytes};
    } finally {await file.close();}
}

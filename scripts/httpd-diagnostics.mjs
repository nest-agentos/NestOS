import {randomUUID} from 'node:crypto';
import {writeSync} from 'node:fs';
import {lifecycleLog} from './httpd-process.mjs';

/** Never include exception messages, arguments, environment values or report dumps. */
export function processErrorMetadata(error) {
    const safe = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : undefined;
    const causeCodes = [], seen = new Set();
    for (let cause = error; cause && !seen.has(cause) && seen.size < 5; cause = cause.cause) {
        seen.add(cause); const code = safe(cause.code); if (code) causeCodes.push(code);
    }
    const locations = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1)
        .filter(line => /^\s+at /.test(line)).map(line => line.match(/((?:file:\/\/)?\/[^\s()]+|node:[^\s()]+):\d+:\d+/)?.[0])
        .filter(Boolean).slice(0, 8).map(value => value.slice(0, 300)) : [];
    return {errorName: safe(error?.name), errorCode: safe(error?.code), causeCodes, locations};
}
function diagnosticWriter(context, started, write) {
    return event => {
        const value = {time: new Date().toISOString(), ppid: process.ppid, ...context, ...event, durationMs: Date.now() - started};
        try {write(value);} catch {
            try {writeSync(2, '[HTTPProcess] ' + JSON.stringify({time: new Date().toISOString(), operation: 'http.process', pid: process.pid,
                ...value, logCode: 'HTTPD_LIFECYCLE_LOG_FAILED'}) + '\n');} catch { /* Preserve the original process outcome. */ }
        }
        return value;
    };
}
/** Monitoring must not turn an uncaught exception or rejection into a successful exit. */
export function installProcessDiagnostics(fields, write = lifecycleLog) {
    const context = {pid: process.pid, ...fields, operationId: fields.operationId ?? randomUUID()};
    const log = diagnosticWriter(context, Date.now(), write);
    let fatal = false, signal;
    process.once('uncaughtExceptionMonitor', (error, origin) => {
        fatal = true; log({stage: 'process.fatal', result: 'failure', origin,
            code: origin === 'unhandledRejection' ? 'HTTPD_UNHANDLED_REJECTION' : 'HTTPD_UNCAUGHT_EXCEPTION', ...processErrorMetadata(error)});
    });
    process.prependOnceListener('exit', exitCode => log({stage: 'process.exit', result: fatal || exitCode !== 0 ? 'failure' : 'success', exitCode,
        signal, code: fatal || exitCode !== 0 ? 'HTTPD_PROCESS_EXIT_FAILED' : 'HTTPD_PROCESS_EXITED'}));
    log({stage: 'process.start', result: 'success'});
    return {log, update: value => Object.assign(context, value), signal: value => {
        signal = value; log({stage: 'process.signal', result: 'received', signal});
    }};
}
/** The parent can observe SIGKILL even though the child cannot write its own exit log. */
export function observeChildProcess(child, fields, write = lifecycleLog) {
    const context = {operationId: randomUUID(), ...fields, pid: child.pid, ppid: process.pid, observerPid: process.pid};
    const log = diagnosticWriter(context, Date.now(), write);
    let stop, exitReceipt;
    child.once('spawn', () => log({stage: 'child.spawn', result: 'success'}));
    child.once('error', error => log({stage: 'child.spawn', result: 'failure', code: 'HTTPD_CHILD_SPAWN_FAILED', ...processErrorMetadata(error)}));
    child.once('exit', (exitCode, signal) => {exitReceipt = log({stage: 'child.exit', exitCode, signal, expected: Boolean(stop), ...stop,
        result: stop && exitCode === 0 && !signal ? 'success' : 'failure',
        code: signal ? 'HTTPD_CHILD_SIGNALLED' : exitCode !== 0 ? 'HTTPD_CHILD_EXIT_FAILED' : stop ? 'HTTPD_CHILD_STOPPED' : 'HTTPD_CHILD_UNEXPECTED_EXIT'});});
    return {expectStop: value => {stop = value;}, get exitReceipt() {return exitReceipt;}};
}

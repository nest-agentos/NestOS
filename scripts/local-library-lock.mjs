import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {acquireBuildLock} from './httpd-build-cache.mjs';

const busy = reason => Object.assign(new Error(`LOCAL_LIBRARIES_BUSY: ${reason}`), {code: 'LOCAL_LIBRARIES_BUSY'});
/** The shared capture mutex serializes inspection and replacement of legacy operation records. */
export function acquireLibraryLock(directory, operationId, report = () => {}) {
    mkdirSync(directory, {recursive: true});
    let release;
    try {release = acquireBuildLock(directory);}
    catch (error) {if (error.message?.startsWith('HTTP_BUILD_BUSY:')) throw busy(error.message.slice('HTTP_BUILD_BUSY:'.length).trim()); throw error;}
    const file = join(directory, 'operation.lock');
    try {
        recover(file, operationId, report);
        writeFileSync(file, JSON.stringify({pid: process.pid, operationId}), {flag: 'wx'});
    } catch (error) {release(); throw error;}
    let closed = false;
    return () => {
        if (closed) return; closed = true;
        try {if (JSON.parse(readFileSync(file, 'utf8')).operationId === operationId) rmSync(file);}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        finally {release();}
    };
}
function recover(file, operationId, report) {
    if (!existsSync(file)) return;
    let owner;
    try {owner = JSON.parse(readFileSync(file, 'utf8'));}
    catch {throw busy('operation lock owner is unreadable; inspect the lock before retrying');}
    if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) throw busy('operation lock owner is invalid; inspect the lock before retrying');
    try {process.kill(owner.pid, 0);}
    catch (error) {
        if (error.code !== 'ESRCH') throw busy(`cannot verify build process ${owner.pid} (${error.code ?? 'unknown'})`);
        rmSync(file);
        report({operationId, stage: 'lock.recover', result: 'success', code: 'LOCK_OWNER_EXITED', previousPid: owner.pid});
        return;
    }
    throw busy(`build process ${owner.pid} is still running; wait for it to finish`);
}

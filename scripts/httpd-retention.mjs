import {existsSync, lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {rm} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {acquireBuildLock} from './httpd-build-cache.mjs';
import {acquireLibraryLock} from './local-library-lock.mjs';
import {readLaunch} from './httpd-launch-state.mjs';
import {withHttpdControl, lifecycleLog} from './httpd-process.mjs';

const releaseId = /^\d{8}T\d{6}-[a-f0-9]{8}(?:-dirty)?$/;
const snapshotId = /^[a-f0-9]{64}$/;
const pending = '.pending-acceptance';
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const invalid = code => Object.assign(new Error(code), {code});

// Shared launchers hold a read transaction throughout candidate checks and rollback.
export function sharedReleaseLease(root, releases) {
    if (path.resolve(root, 'release/httpd') === path.resolve(releases)) return () => {};
    const db = new DatabaseSync(path.join(releases, '.consumers.sqlite'));
    try {db.exec('PRAGMA busy_timeout=5000; BEGIN; SELECT count(*) FROM sqlite_schema');}
    catch (error) {db.close(); throw error;}
    return () => db.close();
}

// A detached child can outlive its launcher. Keep its versions pinned across that gap.
export function pinSharedReleases(root, releases, ids) {
    if (path.resolve(root, 'release/httpd') === path.resolve(releases)) return;
    const key = createHash('sha256').update(path.resolve(root)).digest('hex');
    const file = path.join(releases, '.shared-releases-' + key);
    if (!ids.length) {rmSync(file, {force:true}); return;}
    const temporary = file + '.' + randomUUID();
    writeFileSync(temporary, JSON.stringify(ids.filter(Boolean)), {mode:0o600});
    renameSync(temporary, file);
}

function sharedVersions(releases) {
    const keep = new Set();
    for (const name of readdirSync(releases)) {
        if (!/^\.shared-releases-[a-f0-9]{64}$/.test(name)) continue;
        const ids = read(path.join(releases, name));
        if (!Array.isArray(ids)) throw invalid('HTTPD_CLEANUP_POINTER_INVALID');
        for (const id of ids) keep.add(id);
    }
    return keep;
}

function withReleaseSweep(root, releases, work) {
    if (path.resolve(root, 'release/httpd') !== path.resolve(releases)) return work(false);
    const db = new DatabaseSync(path.join(releases, '.consumers.sqlite'));
    try {
        try {db.exec('BEGIN EXCLUSIVE');}
        catch (error) {if (error.errcode === 5) return work(false); throw error;}
        return work(true);
    } finally {db.close();}
}

function directories(directory) {
    const stat = lstatSync(directory, {throwIfNoEntry: false});
    if (!stat) return [];
    if (!stat.isDirectory()) throw invalid('HTTPD_CLEANUP_DIRECTORY_INVALID');
    return readdirSync(directory, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name);
}

function libraryPointers(directory) {
    const keep = new Set();
    for (const name of ['active.json', 'prepared.json']) {
        const file = path.join(directory, name);
        if (!existsSync(file)) continue;
        const value = read(file);
        if (value.format !== 1) throw invalid('HTTPD_CLEANUP_POINTER_INVALID');
        if (name === 'active.json' && value.mode === 'source') continue;
        if ((name === 'active.json' && value.mode !== 'snapshot') || !snapshotId.test(value.id)) throw invalid('HTTPD_CLEANUP_POINTER_INVALID');
        keep.add(value.id);
    }
    keep.add(process.env.NESTOS_LIBRARY_SNAPSHOT ?? process.env.MINDOS_LIBRARY_SNAPSHOT);
    return keep;
}

function plan(root, releases, version, sweep) {
    const libraries = path.join(root, 'release/local-libraries');
    const snapshots = libraryPointers(libraries), remove = [];
    const selected = read(path.join(releases, 'current.json')).id;
    if (!releaseId.test(selected) || ![selected, version].every(id => lstatSync(path.join(releases,id), {throwIfNoEntry:false})?.isDirectory())) throw invalid('HTTPD_CLEANUP_SELECTION_INVALID');
    const protectedIds = sharedVersions(releases);
    protectedIds.add(selected);
    for (const id of directories(releases).filter(id => releaseId.test(id))) {
        const dir = path.join(releases, id), manifest = read(path.join(dir, 'release.json'));
        if (manifest.id !== id) throw invalid('HTTPD_CLEANUP_MANIFEST_INVALID');
        if (sweep && id < version && !protectedIds.has(id) && !existsSync(path.join(releases, pending, id))) remove.push(dir);
        else snapshots.add(manifest.librarySnapshot);
    }
    const localReleases = path.resolve(root, 'release/httpd');
    if (localReleases !== path.resolve(releases)) {
        for (const id of directories(localReleases).filter(id => releaseId.test(id))) {
            snapshots.add(read(path.join(localReleases, id, 'release.json')).librarySnapshot);
        }
    }
    for (const id of directories(path.join(libraries, 'snapshots'))) {
        if (snapshotId.test(id) && !snapshots.has(id)) remove.push(path.join(libraries, 'snapshots', id));
    }
    return remove;
}

function retire(root, releases, version, operationId) {
    const libraries = path.join(root, 'release/local-libraries');
    const stores = new Set([path.resolve(root, 'release/httpd'), path.resolve(releases)]);
    const locks = [];
    try {
        for (const store of stores) {
            const cache = path.join(store, '.build-cache');
            if (existsSync(path.join(cache, 'lock'))) throw invalid('HTTPD_CLEANUP_BUILD_BUSY');
            locks.push(acquireBuildLock(cache));
        }
        if (existsSync(path.join(libraries, 'lock'))) throw invalid('HTTPD_CLEANUP_BUILD_BUSY');
        locks.push(acquireLibraryLock(libraries, operationId));
        return withReleaseSweep(root, releases, sweep => {
            const obsolete = plan(root, releases, version, sweep);
            if (sweep) rmSync(path.join(releases, pending, version), {force:true});
            for (const dir of obsolete) {
                const name = '.retired-' + randomUUID() + '-' + path.basename(dir);
                renameSync(dir, path.join(path.dirname(dir), name));
            }
            return obsolete.length;
        });
    } finally {for (const unlock of locks.reverse()) unlock();}
}

export async function cleanHealthyRelease(root, releases, version, operationId = randomUUID()) {
    const started = Date.now(), stage = 'launcher.cleanup';
    const report = (result, fields) => lifecycleLog({operationId, version, stage, result, durationMs: Date.now()-started, ...fields});
    try {
        if (!releaseId.test(version)) return false;
        const count = await withHttpdControl(root, async () => {
            const state = await readLaunch(root, 'release');
            if (state?.desiredState !== 'running' || state.childRelease !== version || state.currentRelease !== version
                || (state.operation && !state.receipts?.[state.operation.id])) throw invalid('HTTPD_CLEANUP_STATE_CHANGED');
            return retire(root, releases, version, operationId);
        });
        const bases = [path.join(root, 'release/local-libraries/snapshots')];
        if (path.resolve(root,'release/httpd') === path.resolve(releases)) bases.push(releases);
        for (const base of bases) {
            for (const name of directories(base)) {
                if (!name.startsWith('.retired-')) continue;
                const id = name.slice('.retired-'.length).replace(/^[a-f0-9-]{36}-/, '');
                if ((base === releases ? releaseId : snapshotId).test(id)) await rm(path.join(base,name), {recursive:true, force:true});
            }
        }
        report('success', {count});
        return true;
    } catch (error) {
        report('failure', {code: error.code ?? (error instanceof SyntaxError ? 'HTTPD_CLEANUP_JSON_INVALID' : 'HTTPD_CLEANUP_FAILED'), syscall: error.syscall});
        return false;
    }
}

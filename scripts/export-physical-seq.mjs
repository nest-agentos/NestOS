import {randomUUID} from 'node:crypto';
import {chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {physicalSeqSchema} from '../apps/node-host/src/storage/physical-seq.mjs';

const prefix = '__vfs_seq__:';
const fields = 'SELECT field,value FROM records WHERE path=? ORDER BY field';

function relativeName(name) {
    if (!name.startsWith('/') || !name.endsWith('.seq') || name.includes('\0') ||
        name.slice(1).split('/').some(part => !part || part === '.' || part === '..')) {
        throw new Error('SEQ_INVALID_STORAGE_PATH');
    }
    return name.slice(1);
}

function writeFile(source, file, name) {
    mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    const target = new DatabaseSync(file);
    try {
        chmodSync(file, 0o600);
        target.exec('PRAGMA page_size=1024; BEGIN');
        target.exec(physicalSeqSchema);
        const insert = target.prepare('INSERT INTO entries(key,value) VALUES(?,?)');
        for (const {field,value} of source.prepare(fields).iterate(name)) {
            if (!field.startsWith(prefix)) throw new Error('SEQ_UNSUPPORTED_RECORD_FIELD');
            insert.run(field.slice(prefix.length), value);
        }
        target.exec('COMMIT');
        return verifyFile(source,target,name);
    } finally {target.close();}
}

function verifyFile(source,target,name) {
    const original = source.prepare(fields).iterate(name);
    let count = 0;
    for (const {key,value} of target.prepare('SELECT key,value FROM entries ORDER BY key').iterate()) {
        const row = original.next().value;
        if (!row || row.field !== prefix + key || row.value !== value) throw new Error('SEQ_ENTRY_MISMATCH');
        count++;
    }
    if (!original.next().done || target.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
        throw new Error('SEQ_FILE_INTEGRITY');
    }
    return count;
}

// A private staging directory keeps incomplete snapshots out of the published tree.
export function exportPhysicalSeq(database, destination, roots) {
    if (!roots.length || roots.some(root => !root.startsWith('/') || path.posix.normalize(root) !== root ||
        root.endsWith('/') || root.includes('\0'))) throw new Error('SEQ_INVALID_ROOT');
    mkdirSync(destination, {mode:0o700});
    let staging, source;
    try {
        staging = mkdtempSync(path.join(destination,'.export-'));
        source = new DatabaseSync(database,{readOnly:true});
        source.exec('BEGIN');
        const paths = source.prepare('SELECT DISTINCT path FROM records WHERE path>=? AND path<? ORDER BY path');
        const names = new Set(roots.flatMap(root => paths.all(root+'/',root+'0').map(row => row.path).filter(name => name.endsWith('.seq'))));
        let entries = 0;
        for (const name of names) entries += writeFile(source,path.join(staging,relativeName(name)),name);
        source.exec('COMMIT');
        renameSync(staging,path.join(destination,'files'));
        return {files:names.size,entries};
    } catch (error) {
        if (staging) rmSync(staging,{recursive:true,force:true});
        rmdirSync(destination);
        throw error;
    } finally {source?.close();}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const [database,destination,...roots] = process.argv.slice(2);
    const operationId = randomUUID(), started = Date.now();
    try {
        const result = exportPhysicalSeq(database,destination,roots);
        console.info({operation:'seq.export',operationId,...result,durationMs:Date.now()-started});
    } catch (error) {
        console.error({operation:'seq.export',operationId,code:error.code ?? (/^SEQ_[A-Z_]+$/.test(error.message) ? error.message : error.name),durationMs:Date.now()-started});
        process.exitCode = 1;
    }
}

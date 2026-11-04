import {createHash, randomUUID} from 'node:crypto';
import {open, constants} from 'node:fs/promises';
import {join} from 'node:path';
import {failure} from './identity.mjs';
import {defaultDirectory, prepareDirectory, load} from './registry.mjs';
import {processOutput} from './index.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
/** Admission has a stable resource identity; replay only reconciles that original identity. */
export async function claimOperation(operationId, args) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 256) throw failure('TEMP_PROCESS_OPERATION_REQUIRED');
    const directory = await prepareDirectory(join(defaultDirectory(), 'operations')), path = join(directory, digest(operationId) + '.json');
    const fingerprint = digest(JSON.stringify([args.command, args.args, args.cwd ?? null, args.timeoutMs])), resourceId = randomUUID();
    let file;
    try {file = await open(path, 'wx', 0o600);}
    catch (error) {if (error.code !== 'EEXIST') throw error; return {existing: await existingOperation(path, fingerprint)};}
    try {await file.writeFile(JSON.stringify({schema: 'temporary-operation/1', resourceId, fingerprint})); await file.sync();} finally {await file.close();}
    const dir = await open(directory, 'r'); try {await dir.sync();} finally {await dir.close();}
    return {resourceId};
}
async function existingOperation(path, fingerprint) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); let saved;
    try {const stat = await file.stat(); if (!stat.isFile() || stat.size > 65536 || stat.uid !== process.getuid() || stat.mode & 0o077) throw failure('TEMP_PROCESS_OPERATION_INVALID'); saved = JSON.parse(await file.readFile('utf8'));}
    catch (error) {throw failure(error.code ?? 'TEMP_PROCESS_OPERATION_UNKNOWN');} finally {await file.close();}
    if (saved.schema !== 'temporary-operation/1' || saved.fingerprint !== fingerprint) throw failure('TEMP_PROCESS_OPERATION_CONFLICT');
    let resource; try {resource = await load(defaultDirectory(), saved.resourceId);} catch {throw failure('TEMP_PROCESS_OPERATION_UNKNOWN');}
    if (resource.phase !== 'closed') throw failure(resource.phase === 'unknown' ? 'TEMP_PROCESS_CLEANUP_UNCONFIRMED' : 'TEMP_PROCESS_OPERATION_IN_PROGRESS');
    const output = await processOutput(undefined, resource.id).catch(error => {if (error.code === 'ENOENT') return {}; throw error;});
    return {id: resource.id, reason: resource.reason, outcome: 'unknown', ...resource.result, ...output};
}

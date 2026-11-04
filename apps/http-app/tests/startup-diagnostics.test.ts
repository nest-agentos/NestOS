import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {acquireHostLock, NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {reportHttpStartupFailure} from '@nestos/node-host/http';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close();});
async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'startup-diagnostic-'));
    cleanups.push(() => rm(directory, {recursive: true, force: true})); return directory;
}
it('reports the host lock path, phase and classification, then succeeds once the original owner releases it', async () => {
    const directory = await fixture(), release = await acquireHostLock(directory);
    let error: unknown;
    try {await acquireHostLock(directory);} catch (failure) {error = failure;}
    expect(error).toMatchObject({code:'HOST_LOCK_BUSY', startupDiagnostic:{stage:'storage.host-lock.acquire',database:path.join(directory,'httpd-host-lock.sqlite'),code:'HOST_LOCK_BUSY',operationId:expect.any(String),durationMs:expect.any(Number),openByPids:expect.any(Array)}});
    const log = vi.spyOn(console,'error').mockImplementation(() => {}); reportHttpStartupFailure(error);
    expect(JSON.stringify(log.mock.calls)).toContain('HOST_LOCK_BUSY');expect(JSON.stringify(log.mock.calls)).toContain('Database:');
    release();const recovered=await acquireHostLock(directory);recovered();
});
it('distinguishes corrupt storage from lock contention and preserves a retryable initialization failure', async () => {
    const directory=await fixture(),file=path.join(directory,'corrupt.db');await writeFile(file,'not sqlite');
    await expect(NodeSqliteSidecarDb.open(file)).rejects.toMatchObject({code:'DATABASE_OPEN_FAILED',startupDiagnostic:{stage:'storage.sidecar.initialize',database:file}});
    await rm(file);const db=await NodeSqliteSidecarDb.open(file);await db.close();
});
it('does not print raw configuration, credentials or SQL embedded in an unknown exception', () => {
    const secret='PRIVATE_CONFIGURATION_BODY';const log=vi.spyOn(console,'error').mockImplementation(() => {});
    reportHttpStartupFailure(Object.assign(new Error(secret),{code:'EACCES'}));
    const printed=JSON.stringify(log.mock.calls);expect(printed).not.toContain(secret);expect(printed).toContain('EACCES');expect(printed).toContain('operationId');
});

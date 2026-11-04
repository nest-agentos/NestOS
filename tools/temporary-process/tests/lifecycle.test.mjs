import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, fork, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {temporaryScope, withTemporaryScope, recover, processOutput} from '../node/index.mjs';
import {identity, alive, stopOwned} from '../node/identity.mjs';
import {load, save} from '../node/registry.mjs';
const supported = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], {timeout: 5000}).status === 0;
const command = fileURLToPath(new URL('command.mjs', import.meta.url));
async function until(read, check = Boolean) {for (let i = 0; i < 150; i++) {const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 20));} throw new Error('Fixture did not settle');}
const readJson = path => readFile(path, 'utf8').then(JSON.parse).catch(error => {if (error.code === 'ENOENT') return undefined; throw error;});
async function fixture(t) {const directory = await mkdtemp(join(tmpdir(), 'temporary-process-')); t.after(() => rm(directory, {recursive: true, force: true})); return {directory, output: join(directory, 'fixture-data')};}
async function assertReleased(info) {await assert.rejects(fetch('http://127.0.0.1:' + info.port)); await assert.rejects(fetch('http://127.0.0.1:' + info.childPort));}
async function startOwner(t, directory, output) {
    const owner = fork(fileURLToPath(new URL('owner.mjs', import.meta.url)), [directory, output], {execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc']});
    t.after(() => {owner.kill('SIGKILL');}); const [{id}] = await once(owner, 'message');
    const info = await until(() => readJson(output)), record = await load(directory, id); t.after(() => stopOwned(record)); return {owner, id, info, record};
}
test('normal scope completion releases a real HTTP listener and its descendants', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory, output} = await fixture(t); let info, id;
    await withTemporaryScope({directory, scopeId: 'normal'}, async scope => {
        const process = await scope.start(globalThis.process.execPath, [command, output]); id = process.id;
        info = await until(() => readJson(output)); assert.equal(await (await fetch('http://127.0.0.1:' + info.port)).text(), 'temporary');
    });
    await assertReleased(info); assert.equal((await load(directory, id)).phase, 'closed');
});
test('exceptions, cancellation and deadline all close temporary resources', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    for (const mode of ['exception', 'cancel', 'timeout']) {
        const {directory, output} = await fixture(t), controller = new AbortController(); let info;
        const run = withTemporaryScope({directory, signal: controller.signal}, async scope => {
            const handle = await scope.start(process.execPath, [command, output, 'ignore-term'], {timeoutMs: mode === 'timeout' ? 2000 : 10000});
            info = await until(() => readJson(output));
            if (mode === 'exception') throw new Error('Expected fixture failure');
            if (mode === 'cancel') controller.abort();
            const result = await handle.result; assert.equal(result.outcome, mode === 'timeout' ? 'timed-out' : 'cancelled');
        });
        if (mode === 'exception') await assert.rejects(run, /Expected fixture failure/); else await run;
        await assertReleased(info);
    }
});
test('SIGKILL of the owner triggers cleanup without relying on finally', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory, output} = await fixture(t), f = await startOwner(t, directory, output);
    f.owner.kill('SIGKILL'); await once(f.owner, 'exit');
    await until(() => load(directory, f.id), row => row.phase === 'closed'); await assertReleased(f.info);
});
test('loss of the guardian closes the worker IPC and reclaims its process group', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory, output} = await fixture(t), f = await startOwner(t, directory, output);
    process.kill(f.record.guardian.pid, 'SIGKILL');
    await until(() => load(directory, f.id), row => row.phase === 'closed'); await assertReleased(f.info);
});
test('a fresh recovery process reaps a real orphan left by simultaneous supervisor failure', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory, output} = await fixture(t), f = await startOwner(t, directory, output);
    process.kill(f.record.worker.pid, 'SIGSTOP'); process.kill(f.record.guardian.pid, 'SIGSTOP'); f.owner.kill('SIGSTOP');
    process.kill(f.record.guardian.pid, 'SIGKILL'); f.owner.kill('SIGKILL'); await once(f.owner, 'exit');
    const entry = fileURLToPath(new URL('../node/index.mjs', import.meta.url));
    const recovery = spawn(process.execPath, ['--input-type=module', '-e', `import {recover} from ${JSON.stringify(entry)}; const rows=await recover(${JSON.stringify(directory)}); if(rows.some(row=>row.state==='unknown'))process.exitCode=1;`], {stdio: 'inherit'});
    assert.equal((await once(recovery, 'exit'))[0], 0); await assertReleased(f.info);
    assert.equal((await load(directory, f.id)).phase, 'closed'); assert.deepEqual(await recover(directory), []);
});
test('recovery preserves active owners and never signals an unrelated or reused identity', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory} = await fixture(t), child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached: true, stdio: 'ignore'});
    t.after(() => child.kill('SIGKILL')); await once(child, 'spawn'); const worker = await identity(child.pid), owner = {...await identity(process.pid), pid: 99999999};
    const record = {schema: 'temporary-process/1', id: 'safety', token: 'different-token', phase: 'running', owner, worker: {...worker, start: String(BigInt(worker.start) - 1n)}, expiresAt: Date.now() + 10000};
    await save(directory, record); assert.equal((await recover(directory))[0].state, 'unknown'); assert.equal(await alive(worker), true);
    await save(directory, {...record, worker: {...worker, boot: 'previous-boot'}}); assert.equal((await recover(directory))[0].state, 'recovered'); assert.equal(await alive(worker), true);
    await save(directory, {...record, owner: await identity(process.pid)}); assert.equal((await recover(directory))[0].state, 'active'); assert.equal(await alive(worker), true);
});
test('output is bounded and registry/log diagnostics omit command arguments and content', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory} = await fixture(t), logs = [];
    const result = await withTemporaryScope({directory, log: event => {logs.push(event);}}, async scope => {
        const handle = await scope.start(process.execPath, ['-e', 'console.log("PRIVATE_OUTPUT".repeat(6000))', 'PRIVATE_ARG']); return handle.result;
    });
    const output = await processOutput(directory, result.id); assert.equal(output.outputTruncated, true); assert.ok(output.outputBytes > 65536);
    assert.doesNotMatch(JSON.stringify(await load(directory, result.id)), /PRIVATE_/); assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_/);
    assert.ok(logs.every(row => row.operationId && row.stage && row.result && typeof row.durationMs === 'number'));
});
test('failed spawn, early scope close and corrupt receipts never produce a false running resource', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory} = await fixture(t), scope = await temporaryScope({directory});
    const missing = await scope.start('/definitely-missing-temporary-command'); assert.equal((await missing.result).outcome, 'failed'); await scope.close();
    const other = await temporaryScope({directory}), starting = other.start(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
    const rejected = assert.rejects(starting, {code: 'TEMP_PROCESS_SCOPE_CLOSED'}); await other.close(); await rejected;
    await writeFile(join(directory, 'corrupt.json'), '{', {mode: 0o600}); assert.equal((await recover(directory)).find(row => row.id === 'corrupt').state, 'unknown');
});
test('excess output terminates the scope and keeps its private log bounded', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory} = await fixture(t);
    const result = await withTemporaryScope({directory}, async scope => (await scope.start(process.execPath, ['-e', 'console.log("x".repeat(5*1024*1024));setInterval(()=>{},1000)'])).result);
    assert.equal(result.outcome, 'failed'); assert.equal(result.code, 'TEMP_PROCESS_OUTPUT_LIMIT');
    const output = await processOutput(directory, result.id); assert.ok(output.outputBytes <= 4 * 1024 * 1024);
});
test('unconfirmed cleanup remains a scope failure even when the handle result was already observed', {skip: supported ? false : 'Requires Linux/bwrap user and PID namespaces'}, async t => {
    const {directory, output} = await fixture(t), scope = await temporaryScope({directory});
    const handle = await scope.start(process.execPath, [command, output]), info = await until(() => readJson(output)), record = await load(directory, handle.id);
    try {
        process.kill(record.worker.pid, 'SIGSTOP');
        await save(directory, {...record, token: 'unproven-marker'}); process.kill(record.guardian.pid, 'SIGKILL');
        await assert.rejects(handle.result, {code: 'TEMP_PROCESS_OWNERSHIP_UNKNOWN'});
        await assert.rejects(scope.close(), /TEMP_PROCESS_CLEANUP_UNCONFIRMED/);
    } finally {await stopOwned(record);}
    await assertReleased(info);
});

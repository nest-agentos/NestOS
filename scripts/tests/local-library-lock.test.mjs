import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireLibraryLock} from '../local-library-lock.mjs';

function fixture(t) {
    const directory = mkdtempSync(join(tmpdir(), 'library-lock-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    return {directory, file: join(directory, 'operation.lock')};
}
test('recovers an exited legacy owner and releases both locks', t => {
    const f = fixture(t), exited = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(f.file, JSON.stringify({pid: exited.pid, operationId: 'abandoned'}));
    const events = [], unlock = acquireLibraryLock(f.directory, 'replacement', event => events.push(event));
    assert.equal(JSON.parse(readFileSync(f.file)).operationId, 'replacement');
    assert.equal(events[0].code, 'LOCK_OWNER_EXITED');
    assert.throws(() => acquireLibraryLock(f.directory, 'competitor'), {code: 'LOCAL_LIBRARIES_BUSY'});
    unlock(); unlock(); assert.equal(existsSync(f.file), false); assert.equal(existsSync(join(f.directory, 'lock')), false);
});
test('retains live legacy owners and rejects malformed owner records without deleting them', t => {
    const f = fixture(t);
    for (const record of [JSON.stringify({pid: process.pid}), '{partial', '{}']) {
        writeFileSync(f.file, record);
        assert.throws(() => acquireLibraryLock(f.directory, 'new'), {code: 'LOCAL_LIBRARIES_BUSY'});
        assert.equal(readFileSync(f.file, 'utf8'), record);
        assert.equal(existsSync(join(f.directory, 'lock')), false);
    }
});
test('recovers after an actual SIGKILL without stealing a running process lock', async t => {
    const f = fixture(t), module = new URL('../local-library-lock.mjs', import.meta.url).href;
    const script = `import {acquireLibraryLock} from ${JSON.stringify(module)}; acquireLibraryLock(process.argv[1], 'child'); process.send('ready'); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.directory], {stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
    t.after(() => {if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');});
    await once(child, 'message');
    assert.throws(() => acquireLibraryLock(f.directory, 'competitor'), {code: 'LOCAL_LIBRARIES_BUSY'});
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    const unlock = acquireLibraryLock(f.directory, 'recovered'); unlock();
    assert.equal(existsSync(f.file), false); assert.equal(existsSync(join(f.directory, 'lock')), false);
});
test('does not reclaim a process whose liveness cannot be checked', t => {
    const f = fixture(t); writeFileSync(f.file, JSON.stringify({pid: process.pid}));
    const probe = t.mock.method(process, 'kill', () => {throw Object.assign(new Error('denied'), {code: 'EPERM'});});
    assert.throws(() => acquireLibraryLock(f.directory, 'new'), {code: 'LOCAL_LIBRARIES_BUSY'});
    probe.mock.restore(); assert.equal(existsSync(f.file), true);
});

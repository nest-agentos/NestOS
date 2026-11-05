import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {processIdentity, registerHttpd, runningHttpd, stopHttpd, withHttpdControl} from '../httpd-process.mjs';
async function fixture(mode = 'graceful') {
    const root = await mkdtemp(path.join(tmpdir(), 'httpd-process-')), releases = path.join(root, 'release/httpd');
    const entry = path.join(releases, 'fixture/server/main.js'); await mkdir(path.dirname(entry), {recursive: true});
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await writeFile(entry, `import {DatabaseSync} from 'node:sqlite';
        const db = new DatabaseSync(process.argv[3]); db.exec('BEGIN EXCLUSIVE');
        process.on('SIGTERM', () => {if(process.argv[2] === 'graceful') {db.close();process.exit(0);}});
        setInterval(() => {}, 1000);process.send('ready');`);
    const database = path.join(root, 'host-lock.sqlite');
    const child = spawn(process.execPath, [entry, mode, database], {stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    await once(child, 'message');
    await withHttpdControl(root, () => registerHttpd(root, 'release', child.pid, entry, []));
    return {root, releases, child, database, close: async () => {child.kill('SIGKILL'); if (child.exitCode === null && !child.signalCode) await once(child, 'exit'); await rm(root, {recursive: true, force: true});}};
}
test('stops a registered host without a listening port and verifies the SQLite lock is released', async () => {
    const f = await fixture();
    try {
        const started = Date.now(); await withHttpdControl(f.root, () => stopHttpd(f.root, 'release', f.releases));
        assert.ok(Date.now() - started < 2500); assert.equal(await processIdentity(f.child.pid), undefined);
        const db = new DatabaseSync(f.database); try {db.exec('BEGIN EXCLUSIVE');} finally {db.close();}
        await stopHttpd(f.root, 'release', f.releases);
    } finally {await f.close();}
});
test('escalates a stalled shutdown within the bound and confirms process death before returning', async () => {
    const f = await fixture('stuck');
    try {
        const started = Date.now(); await stopHttpd(f.root, 'release', f.releases, {timeoutMs: 100, force: true});
        assert.ok(Date.now() - started < 2500); assert.equal(await processIdentity(f.child.pid), undefined);
        const db = new DatabaseSync(f.database); try {db.exec('BEGIN EXCLUSIVE');} finally {db.close();}
    } finally {await f.close();}
});
test('rejects a reused PID identity without signaling the unrelated process', async () => {
    const f = await fixture();
    try {
        const file = path.join(f.root, 'release/httpd-processes/release.json'), record = JSON.parse(await readFile(file, 'utf8'));
        record.birth = 'different-boot-and-start'; await writeFile(file, JSON.stringify(record));
        assert.deepEqual(await runningHttpd(f.root, 'release', f.releases), []);
        await stopHttpd(f.root, 'release', f.releases); assert.ok(await processIdentity(f.child.pid));
    } finally {await f.close();}
});
test('serializes lifecycle operations through an OS lock without stale lock files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'httpd-control-'));
    try {
        await withHttpdControl(root, async () => {await assert.rejects(withHttpdControl(root, async () => {}), {code: 'HTTPD_CONTROL_BUSY'});});
        await withHttpdControl(root, async () => {});
    } finally {await rm(root, {recursive: true, force: true});}
});
test('restart waits for the former host to exit and registers exactly one replacement', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'httpd-restart-')), releases = path.join(root, 'release/httpd');
    const entry = path.join(releases, 'fixture/server/main.js'), registry = path.join(root, 'release/httpd-processes/release.json');
    const runners = [];
    async function spawnRunner(command) {
        const child = spawn(process.execPath, ['scripts/httpd.mjs', command], {cwd:root,stdio:'ignore',env:{...process.env,NESTOS_HTTPD_CONTROL_DIR:path.join(root,'control')}}); runners.push(child); return child;
    }
    async function registered(previous = 0) {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const row = await readFile(registry, 'utf8').then(JSON.parse).catch(() => null);
            if (row && row.pid !== previous && await processIdentity(row.pid)) return row;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('REGISTRATION_TIMEOUT');
    }
    try {
        await mkdir(path.dirname(entry), {recursive: true}); await mkdir(path.join(root, 'scripts'));
        await mkdir(path.join(root, 'tools/temporary-process/node'), {recursive: true});
        await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
        for (const name of ['httpd.mjs','httpd-process.mjs','httpd-launcher.mjs','httpd-launch-state.mjs','httpd-child.mjs']) await writeFile(path.join(root, 'scripts', name), await readFile(new URL('../' + name, import.meta.url)));
        await writeFile(path.join(root, 'scripts/httpd-runtime.mjs'), `export const hostArguments=()=>[],hostEnvironment=()=>process.env,runtimePaths=()=>({runtime:'unused'}),runtimeLog=()=>({write(){},close(){}}),releaseDirectory=(r,id)=>r+'/'+id,releasesRoot=root=>root+'/release/httpd',verifyRelease=()=>{};`);
        await writeFile(path.join(root,'scripts/httpd-launch-health.mjs'),'export const launchHealth=()=>async()=>true;');
        await writeFile(path.join(root, 'scripts/httpd-build.mjs'), 'export function buildHttpRelease() {}');
        await writeFile(path.join(root, 'tools/temporary-process/node/index.mjs'), 'export async function recover() {}');
        await writeFile(path.join(releases, 'current.json'), '{"id":"fixture"}');
        await writeFile(entry, "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);");
        await spawnRunner('start'); const first = await registered();
        await spawnRunner('restart'); const second = await registered(first.pid);
        assert.equal(await processIdentity(first.pid), undefined);
        assert.deepEqual((await runningHttpd(root, 'release', releases)).map(row => row.pid), [second.pid]);
        const stop=await spawnRunner('stop');await once(stop,'exit');
        assert.equal(await processIdentity(second.pid),undefined);await new Promise(resolve=>setTimeout(resolve,300));
        assert.deepEqual(await runningHttpd(root,'release',releases),[]);
    } finally {
        for (const child of runners) {if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');}
        const row = await readFile(registry, 'utf8').then(JSON.parse).catch(() => null);
        if (row && await processIdentity(row.pid)) process.kill(row.pid, 'SIGKILL');
        await rm(root, {recursive: true, force: true});
    }
});
test('discovers a pre-registry host launched through a relative script path, without relying on a port', async () => {
    const f = await fixture(); let wrapper, hostPid;
    try {
        f.child.kill('SIGKILL'); await once(f.child, 'exit');
        await rm(path.join(f.root, 'release/httpd-processes/release.json'));
        const entry = path.join(f.releases, 'fixture/server/main.js'); await mkdir(path.join(f.root, 'scripts'));
        await writeFile(path.join(f.root, 'scripts/httpd.mjs'), `import {fork} from 'node:child_process';
            const child=fork(${JSON.stringify(entry)},['graceful',${JSON.stringify(f.database)}],{stdio:['ignore','ignore','ignore','ipc']});
            child.once('message',()=>process.send({pid:child.pid}));child.once('exit',()=>process.exit(0));`);
        wrapper = spawn(process.execPath, ['scripts/httpd.mjs'], {cwd: f.root, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
        [{pid: hostPid}] = await once(wrapper, 'message');
        assert.deepEqual((await runningHttpd(f.root, 'release', f.releases)).map(row => row.pid), [hostPid]);
        await stopHttpd(f.root, 'release', f.releases); assert.equal(await processIdentity(hostPid), undefined);
    } finally {
        if (hostPid && await processIdentity(hostPid)) process.kill(hostPid, 'SIGKILL');
        if (wrapper?.exitCode === null && !wrapper.signalCode) wrapper.kill('SIGKILL'); await f.close();
    }
});

test('safe stop retains a blocked process and its registry until an explicit force request', async () => {
    const f = await fixture('stuck');
    try {
        await assert.rejects(stopHttpd(f.root, 'release', f.releases, {timeoutMs: 30}), {code: 'HTTPD_SAFE_STOP_PENDING'});
        assert.ok(await processIdentity(f.child.pid));
        assert.equal((await runningHttpd(f.root, 'release', f.releases))[0].pid, f.child.pid);
        await stopHttpd(f.root, 'release', f.releases, {timeoutMs: 0, force: true});
        assert.equal(await processIdentity(f.child.pid), undefined);
    } finally {await f.close();}
});
test('the owning launcher can stop its captured process while its startup control lock is still held', async () => {
    const f = await fixture();
    try {
        const record = JSON.parse(await readFile(path.join(f.root, 'release/httpd-processes/release.json'), 'utf8'));
        await withHttpdControl(f.root, () => stopHttpd(f.root, 'release', f.releases, {owned: record}));
        assert.equal(await processIdentity(f.child.pid), undefined);
    } finally {await f.close();}
});

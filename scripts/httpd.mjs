#!/usr/bin/env node
import {recover as recoverTemporaryProcesses} from '../tools/temporary-process/node/index.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { hostArguments, hostEnvironment, runtimePaths, runtimeLog, releaseDirectory, releasesRoot, verifyRelease } from './httpd-runtime.mjs';
import {ensureNativeRuntime} from './httpd-native-runtime.mjs';
import { buildHttpRelease } from './httpd-build.mjs';

import {withHttpdControl, runningHttpd, registerHttpd, unregisterHttpd, stopHttpd, lifecycleLog, setLifecycleLog} from './httpd-process.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = path.join(root, 'apps/http-app'), releases = releasesRoot(root);
const developmentUI = path.join(root, 'release/httpd-dev/dist');
function run(command, args, cwd = root, env = process.env) { execFileSync(command, args, { cwd, stdio: 'inherit', env }); }
function activate(id, directory = releases) {
    verifyRelease(releaseDirectory(directory, id));
    const temporary = path.join(directory, '.current-' + randomUUID());
    writeFileSync(temporary, JSON.stringify({ id }) + '\n'); renameSync(temporary, path.join(directory, 'current.json'));
}
/** A linked worktree shares the main checkout's caches so only changed modules are rebuilt. */
function mainCheckout(directory) {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: directory, encoding: 'utf8' }).trim();
    const shared = path.dirname(common);
    return path.resolve(shared) === path.resolve(directory) ? null : shared;
}
function build(args) {
    const shared = args.includes('--share-main') ? mainCheckout(root) : null;
    const directory = shared ? path.join(shared, 'release/httpd') : releases;
    console.log(`[HTTPBuild] stage=plan source=${root} releases=${directory}${shared ? ' shared=main' : ''}`);
    run(process.execPath, [path.join(root, 'scripts/local-libraries.mjs'), 'build'], root,
        shared ? { ...process.env, NESTOS_LIBRARY_SEED_ROOT: shared } : process.env);
    const id = buildHttpRelease(root, { cache: !args.includes('--no-cache'), releases: directory,
        activate: args.includes('--no-activate') ? undefined : value => activate(value, directory) });
    console.log(`HTTP release ready: ${id}\nStart: ${shared ? `NESTOS_HTTPD_RELEASE_ROOT=${directory} pnpm httpd` : 'pnpm httpd'}\nDevelopment: pnpm httpd:dev`);
    return id;
}
async function serve(mode, args) {
    const hosts = await runningHttpd(root, mode, releases);
    if (hosts.length) throw new Error(`HTTPD_ALREADY_RUNNING: pid=${hosts.map(row => row.pid).join(',')}; use pnpm httpd:restart`);
    if (process.platform === 'linux') await recoverTemporaryProcesses(undefined, event => {
        if (event.result === 'failure') console.warn('[TemporaryProcess]', JSON.stringify(event));
        else console.info('[TemporaryProcess]', JSON.stringify(event));
    });
    let id = 'working-tree', directory = app, entry = path.join(app, 'src/server/main.ts');
    if (mode === 'release') {
        id = JSON.parse(readFileSync(path.join(releases, 'current.json'), 'utf8')).id;
        directory = releaseDirectory(releases, id); verifyRelease(directory); entry = path.join(directory, 'server/main.js');
    } else {ensureNativeRuntime(root);run('pnpm', ['exec', 'vite', 'build', '--outDir', developmentUI, '--emptyOutDir'], app);}
    const command = process.execPath;
    const values = hostArguments(mode, args);
    const childArgs = mode === 'release' ? [entry, ...values] : ['--import', createRequire(path.join(app, 'package.json')).resolve('tsx'), entry, '--static', developmentUI, ...values];
    const file = runtimePaths(mode).runtime, output = runtimeLog(file);
    const banner = `HTTP mode: ${mode}\nVersion: ${id}\nRuntime log: ${file}`; console.log(banner); output.write(Buffer.from(banner + '\n'));
    const child = spawn(command, childArgs, { cwd: directory, stdio: ['inherit', 'pipe', 'pipe'], detached: true,
        env: { ...hostEnvironment(), INIT_CWD: root, NESTOS_HTTPD_MODE: mode, NESTOS_HTTPD_VERSION: id } });
    child.stdout.on('data', chunk => { output.write(chunk); process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output.write(chunk); process.stderr.write(chunk); });
    await supervise(child, mode, entry, args, output);
}
async function supervise(child, mode, entry, args, output) {
    let stopping = false, registration;
    const signals = ['SIGINT', 'SIGTERM'];
    const onSignal = () => {
        if (stopping) return; stopping = true;
        void Promise.resolve(registration).then(owned => owned && stopHttpd(root, mode, releases, {owned})).catch(error => {
            lifecycleLog({pid: child.pid, stage: 'stop', result: 'failure', code: error.code ?? 'HTTPD_STOP_FAILED'}); process.exitCode = 1;
        });
    };
    for (const signal of signals) process.on(signal, onSignal);
    child.once('error', error => {console.error(error.message); process.exitCode = 1;});
    child.once('close', () => output.close());
    let record;
    child.once('exit', (code, signal) => {
        for (const event of signals) process.removeListener(event, onSignal);
        if (record) void withHttpdControl(root, () => unregisterHttpd(root, mode, record)).catch(error => {
            if (error.code !== 'HTTPD_CONTROL_BUSY') lifecycleLog({pid: child.pid, stage: 'registry.remove', result: 'failure', code: error.code ?? 'HTTPD_REGISTRY_FAILED'});
        });
        process.exitCode = stopping ? 0 : code ?? (signal ? 1 : 0);
    });
    try {registration = registerHttpd(root, mode, child.pid, entry, args); record = await registration;
        lifecycleLog({operationId: randomUUID(), pid: child.pid, stage: 'start.registered', result: 'success'});
    } catch (error) {child.kill('SIGTERM'); throw error;}
}
function prepareLifecycleLog(command, args) {
    if (!['start','stop','restart','switch','status','dev','deploy'].includes(command)) return;
    const mode = command === 'dev' || args.includes('--dev') ? 'dev' : 'release';
    try {
        const output = runtimeLog(runtimePaths(mode).runtime);
        setLifecycleLog(chunk => output.write(chunk)); process.once('exit', () => output.close());
    } catch (error) {console.warn('[HTTPProcess] log unavailable:', error.code ?? 'HTTPD_LOG_UNAVAILABLE');}
}
const [command = 'start', ...args] = process.argv.slice(2), commandStarted = Date.now();
try {
    prepareLifecycleLog(command, args);
    if (command === 'deploy' && args.includes('--help')) console.log('Usage: ./httpd.sh [--no-cache]\nBuild, switch the running HTTP service, and verify its version and health.');
    else if (command === 'deploy') await (await import('./httpd-deploy.mjs')).deployHttpd(root, releases, args, build);
    else if (command === 'build') build(args);
    else if (command === 'dev') await withHttpdControl(root, () => serve('dev', args));
    else if(['start','switch','status'].includes(command)||['stop','restart'].includes(command)&&!args.includes('--dev'))await (await import('./httpd-launcher.mjs')).launcherCommand(root,releases,command,args);
    else if (command === 'stop' || command === 'restart') await withHttpdControl(root, async () => {
        const mode = args.includes('--dev') ? 'dev' : 'release';
        const timeoutAt = args.indexOf('--timeout-ms'), timeoutMs = timeoutAt < 0 ? undefined : Number(args[timeoutAt + 1]);
        const forwarded = args.filter((arg, index) => !['--dev', '--force', '--timeout-ms'].includes(arg) && (timeoutAt < 0 || index !== timeoutAt + 1));
        const stopped = await stopHttpd(root, mode, releases, {force: args.includes('--force'), timeoutMs});
        if (command === 'restart') await serve(mode, forwarded.length ? forwarded : stopped?.args ?? []);
    });
    else if (command === 'activate' && args[0]) activate(args[0]);
    else if (command === 'list') {
        for (const entry of readdirSync(releases)) if (!entry.startsWith('.') && entry !== 'current.json') console.log(entry);
    }
    else throw new Error('Usage: httpd.mjs deploy [--no-cache] | build [--share-main] [--no-cache] [--no-activate] | start [httpd options] | dev [httpd options] | stop [--dev] | restart [--dev] [httpd options] | switch <release-id> [--expected-current <id>] [--operation-id <id>] [--service-id <id>] | status | list | activate <release-id>');
} catch (error) {
    lifecycleLog({operationId: randomUUID(), stage: command, result: 'failure', code: error.code ?? 'HTTPD_COMMAND_FAILED', durationMs: Date.now() - commandStarted});
    console.error(error.code === 'ENOENT' && command === 'start' ? 'No HTTP release found. Run pnpm httpd:build first.' : error.message); process.exitCode = 1;
}

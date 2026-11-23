import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, readlink, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createServiceControl} from './index.mjs';
import {command, installedConfig, installedExecutable, serviceStorage} from './guest.mjs';
import {digest, fail, packageArtifact, validId} from './artifact.mjs';

const localUnit = 'nestos-cells-local.service';

export function targetsFor(target = 'all') {
    if (target === 'all') return ['cells-x1', 'local'];
    if (target === 'cells-x1' || target === 'local') return [target];
    throw fail('CELLS_REDEPLOY_TARGET_INVALID');
}

export async function build(root) {
    const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args],
        {encoding: 'utf8', timeout: 10000}).trim();
    const cells = path.join(root, 'tools/cells'), output = path.join(root, 'release/cells-build');
    const commit = git(root, 'rev-parse', 'HEAD'), before = git(cells, 'rev-parse', 'HEAD');
    const dirty = () => git(root, 'status', '--porcelain', '--untracked-files=no');
    if (dirty()) throw fail('BUILD_SOURCE_DIRTY');
    execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(cells, 'Cargo.toml'),
        '--target-dir', output], {cwd: root, stdio: 'inherit', timeout: 600000});
    if (git(root, 'rev-parse', 'HEAD') !== commit || dirty() || git(cells, 'rev-parse', 'HEAD') !== before)
        throw fail('BUILD_SOURCE_CHANGED');
    return packageArtifact(root, commit, path.join(output, 'release/cells'));
}

export async function sameDirectory(first, second) {
    const [a, b] = await Promise.all([stat(first, {bigint: true}), stat(second, {bigint: true})]);
    return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
}

export async function sameExecutablePath(running, expected) {
    const executable = running.replace(/ \(deleted\)$/, '');
    return path.basename(executable) === path.basename(expected)
        && (path.dirname(executable) === path.dirname(expected)
            || await sameDirectory(path.dirname(executable), path.dirname(expected)));
}

async function vmOptions() {
    const config = path.join(homedir(), '.config/nestos/service-modules.json');
    let raw = process.env.NESTOS_SERVICE_MODULES;
    if (!raw) {
        try { raw = await readFile(config, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') throw fail('SERVICE_MODULE_CONFIG_MISSING'); throw error; }
    }
    let entries;
    try { entries = JSON.parse(raw); }
    catch { throw fail('SERVICE_MODULE_CONFIGURATION_INVALID'); }
    if (!Array.isArray(entries)) throw fail('SERVICE_MODULE_CONFIGURATION_INVALID');
    const matches = entries.filter(entry => entry?.id === 'cells-x1');
    if (!matches.length) throw fail('SERVICE_TARGET_UNAVAILABLE');
    if (matches.length > 1) throw fail('SERVICE_MODULE_DUPLICATE_TARGET');
    return matches[0].options;
}

async function vmControl(root) {
    const options = await vmOptions();
    if (options?.id !== 'cells-x1' || !validId(options.vm) || typeof options.root !== 'string' || !path.isAbsolute(options.root))
        throw fail('SERVICE_BINDING_MISMATCH');
    if (!await sameDirectory(options.root, root)) throw fail('SERVICE_SOURCE_ROOT_MISMATCH');
    if (options.executable !== installedExecutable) throw fail('CELLS_INSTALL_GUEST_BINDING_MISMATCH');
    return createServiceControl(options);
}

async function localPid() {
    const status = await command('systemctl', ['show', localUnit, '-p', 'ActiveState', '-p', 'MainPID']);
    const fields = Object.fromEntries(status.split('\n').map(line => line.split('=')));
    return fields.ActiveState === 'active' && /^[1-9][0-9]*$/.test(fields.MainPID) ? fields.MainPID : undefined;
}

async function localControl(root) {
    const stateDirectory = path.join(homedir(), '.local/state/nestos/cells-redeploy-local');
    return createServiceControl({id: 'local', vm: 'local', root, executable: installedExecutable, stateDirectory,
        identity: '/dev/null', server: '/dev/null'}, {
        ...serviceStorage((args, input) => command('sudo', ['-n', ...args], 120000, input)),
        ready: async () => await localPid() !== undefined,
        hash: async () => {
            const pid = await localPid();
            if (!pid) throw fail('SERVICE_NOT_READY');
            const proc = '/proc/' + pid + '/exe';
            if (!await sameExecutablePath(await readlink(proc), installedExecutable))
                throw fail('LOCAL_CELLS_EXECUTABLE_MISMATCH');
            const [, config] = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0');
            if (config !== installedConfig) throw fail('CELLS_CONFIG_BINDING_MISMATCH');
            return digest(await readFile(proc));
        },
        restart: () => command('sudo', ['-n', 'systemctl', 'restart', localUnit], 120000),
    });
}

export const finishedTarget = row => row.state === 'succeeded' || row.state === 'unchanged';

const controlFor = (root, target) => target === 'local' ? localControl(root) : vmControl(root);

export async function redeploy(root, targets, operations = {build, controlFor}) {
    const operationId = randomUUID();
    const report = {operation: 'cells.redeploy', operationId, targets: []};
    const plans = await preflight(root, targets, operations.controlFor, operationId);
    if (plans.some(plan => plan.code)) {
        report.targets = plans.map(({target, code}) => code
            ? {target, state: 'failed', code} : {target, state: 'skipped', code: 'PREFLIGHT_INCOMPLETE'});
        return report;
    }
    const artifact = await operations.build(root);
    report.version = artifact.value.id;
    for (const plan of plans) {
        const previous = report.targets.at(-1);
        const result = previous && !finishedTarget(previous)
            ? {state: 'skipped', code: 'EARLIER_TARGET_INCOMPLETE'}
            : await deploy(plan, artifact, operationId);
        report.targets.push({target: plan.target, ...result});
    }
    return report;
}

async function preflight(root, targets, resolveControl, operationId) {
    return Promise.all(targets.map(async target => {
        const started = Date.now();
        const log = (result, code) => console.info(JSON.stringify({operation: 'cells.redeploy',
            operationId, target, stage: 'preflight', result, code, durationMs: Date.now() - started}));
        try {
            const control = await resolveControl(root, target);
            const current = await control.describe();
            log('success');
            return {target, control, expectedVersion: current.version};
        } catch (error) {
            const code = error.code ?? 'SERVICE_PREFLIGHT_FAILED';
            log('failure', code);
            return {target, code};
        }
    }));
}

async function deploy({control, target, expectedVersion}, artifact, operationId) {
    const request = {operationId, serviceId: target, expectedVersion, targetVersion: artifact.value.id};
    try {
        await control.verifyArtifact({...request, version: request.targetVersion,
            sha256: artifact.digest, sourceVersion: artifact.value.commit});
        await control.submit(request);
        return present(await control.inspect(request));
    } catch (error) {
        return {state: 'failed', code: error.code ?? 'SERVICE_REDEPLOY_FAILED'};
    }
}

function present(receipt) {
    return receipt.state === 'succeeded' && receipt.changed === false ? {...receipt, state: 'unchanged'} : receipt;
}

export async function redeployStatus(root, targets, operationId) {
    if (!validId(operationId)) throw fail('SERVICE_REQUEST_INVALID');
    const report = {operation: 'cells.redeploy-status', operationId, targets: []};
    for (const target of targets) {
        try {
            const control = await controlFor(root, target);
            report.targets.push({target, ...present(await control.inspectOperation(operationId))});
        } catch (error) {
            report.targets.push({target, state: 'failed', code: error.code ?? 'SERVICE_STATUS_FAILED'});
        }
    }
    return report;
}

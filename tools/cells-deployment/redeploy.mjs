import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, readlink, realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createServiceControl} from './index.mjs';
import {command, ready, runningHash} from './guest.mjs';
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

async function vmControl(root) {
    const config = path.join(homedir(), '.config/nestos/service-modules.json');
    const entries = JSON.parse(process.env.NESTOS_SERVICE_MODULES ?? await readFile(config, 'utf8'));
    const selected = entries.find(entry => entry.id === 'cells-x1');
    if (selected?.options?.id !== 'cells-x1' || selected.options.vm !== 'cells-x1'
        || await realpath(selected.options.root) !== await realpath(root)) throw fail('SERVICE_TARGET_UNAVAILABLE');
    return createServiceControl({...selected.options, keepPrevious: true}, {command, ready, hash: runningHash});
}

async function localPid() {
    const status = await command('systemctl', ['show', localUnit, '-p', 'ActiveState', '-p', 'MainPID']);
    const fields = Object.fromEntries(status.split('\n').map(line => line.split('=')));
    return fields.ActiveState === 'active' && /^[1-9][0-9]*$/.test(fields.MainPID) ? fields.MainPID : undefined;
}

async function localControl(root) {
    const executable = path.join(root, 'tools/svr');
    const stateDirectory = path.join(homedir(), '.local/state/nestos/cells-redeploy-local');
    return createServiceControl({id: 'local', vm: 'local', root, executable, stateDirectory,
        identity: '/dev/null', server: '/dev/null', keepPrevious: true}, {
        ready: async () => await localPid() !== undefined,
        hash: async () => {
            const pid = await localPid();
            if (!pid) throw fail('SERVICE_NOT_READY');
            const proc = '/proc/' + pid + '/exe';
            if ((await readlink(proc)).replace(/ \(deleted\)$/, '') !== executable)
                throw fail('LOCAL_CELLS_EXECUTABLE_MISMATCH');
            return digest(await readFile(proc));
        },
        restart: () => command('sudo', ['-n', 'systemctl', 'restart', localUnit], 120000),
    });
}

const controlFor = (root, target) => target === 'local' ? localControl(root) : vmControl(root);

export async function redeploy(root, targets, operations = {build, controlFor}) {
    const operationId = randomUUID();
    const report = {operation: 'cells.redeploy', operationId, targets: []};
    const plans = await preflight(root, targets, operations.controlFor);
    if (plans.some(plan => plan.code)) {
        report.targets = plans.map(({target, code}) => code
            ? {target, state: 'failed', code} : {target, state: 'skipped', code: 'PREFLIGHT_INCOMPLETE'});
        return report;
    }
    const artifact = await operations.build(root);
    report.version = artifact.value.id;
    for (const plan of plans) {
        const previous = report.targets.at(-1);
        const result = previous && previous.state !== 'succeeded'
            ? {state: 'skipped', code: 'EARLIER_TARGET_INCOMPLETE'}
            : await deploy(plan, artifact, operationId);
        report.targets.push({target: plan.target, ...result});
    }
    return report;
}

async function preflight(root, targets, resolveControl) {
    return Promise.all(targets.map(async target => {
        try {
            const control = await resolveControl(root, target);
            const current = await control.describe();
            return {target, control, expectedVersion: current.version};
        } catch (error) {
            return {target, code: error.code ?? 'SERVICE_PREFLIGHT_FAILED'};
        }
    }));
}

async function deploy({control, target, expectedVersion}, artifact, operationId) {
    const request = {operationId, serviceId: target, expectedVersion, targetVersion: artifact.value.id};
    try {
        await control.verifyArtifact({...request, version: request.targetVersion,
            sha256: artifact.digest, sourceVersion: artifact.value.commit});
        await control.submit(request);
        return await control.inspect(request);
    } catch (error) {
        return {state: 'failed', code: error.code ?? 'SERVICE_REDEPLOY_FAILED'};
    }
}

export async function redeployStatus(root, targets, operationId) {
    if (!validId(operationId)) throw fail('SERVICE_REQUEST_INVALID');
    const report = {operation: 'cells.redeploy-status', operationId, targets: []};
    for (const target of targets) {
        try {
            const control = await controlFor(root, target);
            report.targets.push({target, ...await control.inspectOperation(operationId)});
        } catch (error) {
            report.targets.push({target, state: 'failed', code: error.code ?? 'SERVICE_STATUS_FAILED'});
        }
    }
    return report;
}

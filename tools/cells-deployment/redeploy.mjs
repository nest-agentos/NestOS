import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFile, readlink, realpath, stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {createServiceControl} from './index.mjs';
import {checkedGeneration, command, installedConfig, installedExecutable, readConfiguration, serviceStorage} from './guest.mjs';
import {digest, fail, packageArtifact, validId} from './artifact.mjs';

const localUnit = 'nestos-cells-local.service';

export function targetsFor(target = 'all') {
    if (target === 'all') return ['cells-x1', 'local'];
    if (target === 'cells-x1' || target === 'local') return [target];
    throw fail('CELLS_REDEPLOY_TARGET_INVALID');
}

export function parseRedeployArgs(args) {
    let target, configOnly = false;
    for (const arg of args) {
        if (arg === '--config-only') {
            if (configOnly) throw fail('CELLS_REDEPLOY_ARGUMENTS_INVALID');
            configOnly = true;
        } else if (arg.startsWith('-') || target !== undefined) {
            throw fail('CELLS_REDEPLOY_ARGUMENTS_INVALID');
        } else {
            target = arg;
        }
    }
    return {targets: targetsFor(target), configOnly};
}

function cellsSourceDirty(root, cells, git) {
    return Boolean(git(root, 'status', '--porcelain', '--untracked-files=no', '--', 'tools/cells')
        || git(cells, 'status', '--porcelain', '--untracked-files=no', '--', '.'));
}

export async function build(root, compile) {
    const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args],
        {encoding: 'utf8', timeout: 10000}).trim();
    const cells = path.join(root, 'tools/cells'), output = path.join(root, 'release/cells-build');
    const commit = git(root, 'rev-parse', 'HEAD'), before = git(cells, 'rev-parse', 'HEAD');
    const dirty = () => cellsSourceDirty(root, cells, git);
    if (dirty()) throw fail('BUILD_SOURCE_DIRTY');
    if (compile) await compile({root, cells, output});
    else execFileSync('cargo', ['build', '--locked', '--release', '--manifest-path', path.join(cells, 'Cargo.toml'),
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
    return createServiceControl({...options, configSource: process.env.NESTOS_CELLS_X1_CONFIG ?? options.configSource});
}

async function localPid() {
    const status = await command('systemctl', ['show', localUnit, '-p', 'ActiveState', '-p', 'MainPID']);
    const fields = Object.fromEntries(status.split('\n').map(line => line.split('=')));
    return fields.ActiveState === 'active' && /^[1-9][0-9]*$/.test(fields.MainPID) ? fields.MainPID : undefined;
}

async function localProcess() {
    const pid = await localPid();
    if (!pid) throw fail('SERVICE_NOT_READY');
    const proc = '/proc/' + pid;
    if (!await sameExecutablePath(await readlink(proc + '/exe'), installedExecutable))
        throw fail('LOCAL_CELLS_EXECUTABLE_MISMATCH');
    const [, config] = (await readFile(proc + '/cmdline', 'utf8')).split('\0');
    if (config !== installedConfig) throw fail('CELLS_CONFIG_BINDING_MISMATCH');
    const [binary, status, boot] = await Promise.all([readFile(proc + '/exe'), readFile(proc + '/stat', 'utf8'),
        readFile('/proc/sys/kernel/random/boot_id', 'utf8')]);
    const start = status.slice(status.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    return {hash: digest(binary), generation: checkedGeneration(boot.trim() + ':' + pid + ':' + start)};
}

async function localControl(root) {
    const stateDirectory = path.join(homedir(), '.local/state/nestos/cells-redeploy-local');
    return createServiceControl({id: 'local', vm: 'local', root, executable: installedExecutable, stateDirectory,
        identity: '/dev/null', server: '/dev/null',
        configSource: process.env.NESTOS_CELLS_LOCAL_CONFIG ?? path.join(root, 'tools/cells.toml')}, {
        ...serviceStorage((args, input) => command('sudo', ['-n', ...args], 120000, input)),
        ready: async () => await localPid() !== undefined,
        process: localProcess,
        hash: async () => (await localProcess()).hash,
        restart: () => command('sudo', ['-n', 'systemctl', 'restart', localUnit], 120000),
    });
}

export {readConfiguration} from './guest.mjs';

const serviceSources = '/etc/nestos/firecracker/service-sources';
const parseManifest = `
import json, sys, tomllib
try:
    manifest = tomllib.loads(sys.stdin.read())
    print(json.dumps({"id": manifest.get("id"), "files": manifest.get("files", [])}))
except (TypeError, ValueError):
    sys.exit(1)
`;

export async function vmConfigurationSource(id, source, directory = serviceSources) {
    if (source !== undefined) return source;
    if (id !== 'cells-x1') throw fail('CELLS_CONFIG_SOURCE_REQUIRED');
    const parent = path.join(directory, id);
    const manifest = await readConfiguration(path.join(parent, 'service.toml'), {privateFile: false})
        .catch(error => {
            throw fail(error.code === 'CELLS_CONFIG_SOURCE_UNAVAILABLE'
                ? 'CELLS_CONFIG_MANIFEST_UNAVAILABLE' : 'CELLS_CONFIG_MANIFEST_INVALID');
        });
    const definition = await command('python3', ['-c', parseManifest], 5000, manifest).then(JSON.parse)
        .catch(() => {throw fail('CELLS_CONFIG_MANIFEST_INVALID');});
    if (definition.id !== id || !Array.isArray(definition.files)) throw fail('CELLS_CONFIG_MANIFEST_INVALID');
    const candidate = configurationAsset(definition.files);
    const config = path.join(parent, candidate);
    const root = await realpath(parent);
    const resolved = await realpath(config).catch(() => {throw fail('CELLS_CONFIG_SOURCE_UNAVAILABLE');});
    if (resolved !== path.join(root, candidate)) throw fail('CELLS_CONFIG_SOURCE_INVALID');
    return config;
}

function configurationAsset(files) {
    const direct = files.filter(file => file?.target === 'cells.toml');
    const legacy = files.filter(file => file?.target === 'config.toml');
    const candidates = direct.length ? direct : legacy;
    if (!candidates.length) throw fail('CELLS_CONFIG_MANIFEST_SOURCE_NOT_DECLARED');
    if (candidates.length !== 1) throw fail('CELLS_CONFIG_MANIFEST_SOURCE_AMBIGUOUS');
    const source = candidates[0].source;
    if (typeof source !== 'string' || source.split('/').some(part => ['', '.', '..'].includes(part)))
        throw fail('CELLS_CONFIG_SOURCE_INVALID');
    return source;
}

export async function deploymentConfiguration(control, resolveSource = vmConfigurationSource) {
    const {id, configSource} = control.options;
    let source = configSource;
    let kind = id === 'local' ? 'local-file' : 'vm-file';
    if (id === 'cells-x1' && source === undefined) {
        try {source = await resolveSource(id);}
        catch (error) {
            if (error.code !== 'CELLS_CONFIG_MANIFEST_UNAVAILABLE') throw error;
            const bytes = await control.installedConfiguration();
            const sha256 = digest(bytes);
            return {bytes, sha256, previous: sha256, kind: 'vm-installed'};
        }
        kind = 'vm-manifest';
    }
    const bytes = await readConfiguration(source);
    return {bytes, sha256: digest(bytes), previous: await control.configuration(), kind};
}

async function validateConfig(binary, bytes) {
    try {await command(binary, ['--check-config', '-'], 15000, bytes);}
    catch {throw fail('CELLS_CONFIG_INVALID');}
}

export const finishedTarget = row => row.state === 'succeeded' || row.state === 'unchanged';

const controlFor = (root, target) => target === 'local' ? localControl(root) : vmControl(root);

export async function redeploy(root, targets, operations, options = {}) {
    const provided = operations ?? {};
    const resolved = operations === undefined
        ? {build, controlFor, deploymentConfiguration, validateConfig}
        : {build, controlFor, ...provided};
    const configOnly = options.configOnly === true;
    const operationId = randomUUID();
    const report = {operation: 'cells.redeploy', operationId, ...(configOnly ? {mode: 'config-only'} : {}), targets: []};
    const plans = await preflight(root, targets, resolved, operationId);
    if (plans.some(plan => plan.code)) {
        report.targets = plans.map(({target, code}) => code
            ? {target, state: 'failed', code} : {target, state: 'skipped', code: 'PREFLIGHT_INCOMPLETE'});
        return report;
    }
    const artifact = configOnly ? undefined : await resolved.build(root);
    if (artifact) report.version = artifact.value.id;
    const validator = configOnly
        ? (provided.validateConfig ?? ((_binary, bytes, control) => control.validateConfiguration(bytes)))
        : resolved.validateConfig;
    const invalid = await checkConfigurations(plans, artifact?.binary, validator, operationId, configOnly);
    if (invalid) {
        report.targets = plans.map(row => row.target === invalid.target
            ? {target: row.target, state: 'failed', code: invalid.code}
            : {target: row.target, state: 'skipped', code: 'PREFLIGHT_INCOMPLETE'});
        return report;
    }
    for (const plan of plans) {
        const previous = report.targets.at(-1);
        const result = previous && !finishedTarget(previous)
            ? {state: 'skipped', code: 'EARLIER_TARGET_INCOMPLETE'}
            : configOnly ? await deployConfigOnly(plan, operationId) : await deploy(plan, artifact, operationId);
        report.targets.push({target: plan.target, ...result});
    }
    return report;
}

async function checkConfigurations(plans, binary, validate, operationId, requireConfig = false) {
    for (const {target, control, config} of plans) {
        if (!config) {
            if (!requireConfig) continue;
            return {target, code: 'CELLS_CONFIG_SOURCE_REQUIRED'};
        }
        const started = Date.now();
        const event = (result, code) => console.info(JSON.stringify({operation: 'cells.redeploy', operationId,
            target, stage: 'config.validate', result, code, durationMs: Date.now() - started}));
        try {await validate(binary, config.bytes, control); event('success');}
        catch (error) {
            const code = error.code ?? 'CELLS_CONFIG_INVALID';
            event('failure', code);
            return {target, code};
        }
    }
}
async function preflight(root, targets, operations, operationId) {
    return Promise.all(targets.map(async target => {
        const started = Date.now();
        const log = (result, code, configurationSource) => console.info(JSON.stringify({operation: 'cells.redeploy',
            operationId, target, stage: 'preflight', result, code, configurationSource, durationMs: Date.now() - started}));
        try {
            const control = await operations.controlFor(root, target);
            const current = await control.describe();
            const config = await operations.deploymentConfiguration?.(control);
            log('success', undefined, config?.kind);
            return {target, control, expectedVersion: current.version, config};
        } catch (error) {
            const code = error.code ?? 'SERVICE_PREFLIGHT_FAILED';
            log('failure', code);
            return {target, code};
        }
    }));
}

async function deploy({control, target, expectedVersion, config}, artifact, operationId) {
    const request = {operationId, serviceId: target, expectedVersion, targetVersion: artifact.value.id,
        ...(config ? {configSha256: config.sha256, expectedConfigSha256: config.previous} : {})};
    try {
        await control.verifyArtifact({...request, version: request.targetVersion,
            sha256: artifact.digest, sourceVersion: artifact.value.commit});
        await control.submit(request, config?.bytes);
        return present(await control.inspect(request));
    } catch (error) {
        return {state: 'failed', code: error.code ?? 'SERVICE_REDEPLOY_FAILED'};
    }
}

async function deployConfigOnly({control, target, expectedVersion, config}, operationId) {
    const request = {operationId, serviceId: target, expectedVersion, targetVersion: expectedVersion,
        configOnly: true, configSha256: config.sha256, expectedConfigSha256: config.previous};
    try {
        await control.submit(request, config.bytes);
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

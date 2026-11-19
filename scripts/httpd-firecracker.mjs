import {spawnSync} from 'node:child_process';
import {lifecycleLog} from './httpd-process.mjs';

const unit = 'firecracker-server.service';
const server = '/usr/local/bin/firecracker-server';
const vmId = 'cells-x1';

function failure(code) {
    return Object.assign(new Error(code), {code});
}

function runCommand(command, args, privileged = false) {
    if (privileged && process.getuid() !== 0) {
        args = ['--', command, ...args];
        command = 'sudo';
    }
    const result = spawnSync(command, args, {encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe']});
    if (result.error) throw result.error;
    if (result.status === 0) return result.stdout;
    const sudoError = /^sudo: (?:a (?:password|terminal) is required|.*is not (?:allowed|in the sudoers file))/m.test(result.stderr);
    if (sudoError) throw failure('SUDO_AUTHORIZATION_REQUIRED');
    const cliCode = result.stderr.match(/^Error: ([A-Z][A-Z0-9_]{2,63})\b/m)?.[1];
    throw failure(cliCode ?? result.signal ?? `EXIT_${result.status}`);
}

function step(operationId, stage, hint, run) {
    const started = Date.now();
    try {
        const {code, value} = run();
        lifecycleLog({operationId, stage, result: 'success', code, durationMs: Date.now() - started});
        return value;
    } catch (error) {
        const code = error.code ?? 'HTTPD_FIRECRACKER_FAILED';
        lifecycleLog({operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
        throw Object.assign(new Error(`${stage}: ${code}. ${hint}`), {code});
    }
}

function serverStatus(output) {
    const load = output.match(/^LoadState=(\S+)$/m)?.[1];
    const active = output.match(/^ActiveState=(\S+)$/m)?.[1];
    if (load === 'not-found') return {code: 'UNIT_NOT_FOUND'};
    if (load !== 'loaded' || !active) throw failure(load ? `UNIT_${load.replaceAll('-', '_').toUpperCase()}` : 'INVALID_UNIT_STATUS');
    return {value: active, code: active === 'active' ? 'UNIT_ACTIVE' : 'UNIT_START_REQUIRED'};
}

function vmStatus(output) {
    let inventory;
    try {inventory = JSON.parse(output);} catch {throw failure('INVALID_VM_INVENTORY');}
    if (!Array.isArray(inventory?.vms)) throw failure('INVALID_VM_INVENTORY');
    const vm = inventory.vms.find(row => row?.id === vmId);
    if (!vm) return {code: 'VM_NOT_FOUND'};
    if (!['stopped', 'vmm-running', 'starting', 'stopping'].includes(vm.state)) throw failure('INVALID_VM_STATE');
    return {code: `VM_${vm.state.replaceAll('-', '_').toUpperCase()}`, value: vm};
}

export function prepareRestartFirecracker(operationId, run = runCommand) {
    const serviceHint = `Inspect systemctl status ${unit} and journalctl -u ${unit}.`;
    const status = step(operationId, 'firecracker.server.status', serviceHint, () =>
        serverStatus(run('systemctl', ['show', '--property=LoadState,ActiveState', unit])));
    if (!status) return;
    if (status !== 'active') step(operationId, 'firecracker.server.start', serviceHint, () => {
        run('systemctl', ['start', unit], true);
        return {code: 'UNIT_STARTED'};
    });
    const vm = step(operationId, 'firecracker.vm.status', 'Try ./tools/fc-server/vmm.sh list --all.', () =>
        vmStatus(run(server, ['list', '--all', '--json'], true)));
    if (vm?.state !== 'stopped') return;
    const args = vm.service ? ['service', 'start', vmId] : ['start', vmId];
    step(operationId, 'firecracker.vm.start', `Try ./tools/fc-server/vmm.sh ${args.join(' ')}.`, () => {
        run(server, args, true);
        return {code: 'VM_STARTED'};
    });
}

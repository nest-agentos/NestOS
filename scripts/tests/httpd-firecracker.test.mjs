import assert from 'node:assert/strict';
import {test} from 'node:test';
import {prepareRestartFirecracker, prepareRestartLocalCells} from '../httpd-restart-dependencies.mjs';

const unit = 'firecracker-server.service';
const server = '/usr/local/bin/firecracker-server';
const status = ['systemctl', ['show', '--property=LoadState,ActiveState', unit]];
const start = ['systemctl', ['start', unit], true];
const list = [server, ['list', '--all', '--json'], true];
const unitStatus = (load, active) => `LoadState=${load}\nActiveState=${active}\n`;

const scenarios = [
    ['skips an uninstalled service', unitStatus('not-found', 'inactive'), [], [status]],
    ['starts the inactive service, then starts the stopped VM', unitStatus('loaded', 'inactive'),
        [{id: 'cells-x1', state: 'stopped'}], [status, start, list, [server, ['start', 'cells-x1'], true]]],
    ['uses the existing service binding for a stopped managed VM', unitStatus('loaded', 'active'),
        [{id: 'cells-x1', state: 'stopped', service: 'managed'}], [status, list, [server, ['service', 'start', 'cells-x1'], true]]],
    ['does not use a service package ID as a VM ID', unitStatus('loaded', 'active'),
        [{id: 'cell-x1', state: 'stopped', service: 'cells-x1'}], [status, list]],
    ...['vmm-running', 'starting', 'stopping'].map(state => [`does not start a VM in state ${state}`,
        unitStatus('loaded', 'active'), [{id: 'cells-x1', state}], [status, list]]),
];

for (const [name, unitOutput, vms, expected] of scenarios) {
    test(name, () => {
        const calls = [];
        prepareRestartFirecracker('test-restart', (...call) => {
            calls.push(call);
            if (call[1][0] === 'show') return unitOutput;
            if (call[1][0] === 'list') return JSON.stringify({vms});
        });
        assert.deepEqual(calls, expected);
    });
}

test('reports an inventory failure with its stage and operation ID', t => {
    const logs = t.mock.method(console, 'info', () => {});
    assert.throws(() => prepareRestartFirecracker('test-restart', (command, args) => {
        if (args[0] === 'show') return unitStatus('loaded', 'active');
        assert.deepEqual([command, args], list.slice(0, 2));
        return 'invalid inventory';
    }), {code: 'INVALID_VM_INVENTORY', message: /firecracker\.vm\.status/});
    const message = logs.mock.calls.at(-1).arguments[0];
    const event = JSON.parse(message.slice('[HTTPProcess] '.length));
    assert.equal(event.operationId, 'test-restart');
    assert.equal(event.stage, 'firecracker.vm.status');
    assert.equal(event.result, 'failure');
    assert.equal(event.code, 'INVALID_VM_INVENTORY');
    assert.equal(typeof event.durationMs, 'number');
    assert.doesNotMatch(message, /invalid inventory/);
});

test('does not query the VM inventory if the service fails to start', () => {
    const calls = [];
    assert.throws(() => prepareRestartFirecracker('test-restart', (...call) => {
        calls.push(call);
        if (call[1][0] === 'show') return unitStatus('loaded', 'failed');
        throw Object.assign(new Error('private subprocess output'), {code: 'EXIT_1'});
    }), {code: 'EXIT_1', message: /^firecracker\.server\.start: EXIT_1\./});
    assert.deepEqual(calls, [status, start]);
});

test('starts the installed local Cells service only when inactive and confirms readiness', () => {
    const local = 'nestos-cells-local.service';
    const show = ['systemctl', ['show', '--property=LoadState,ActiveState', local]];
    const startLocal = ['systemctl', ['start', local], true];
    for (const [initial, expected] of [
        [unitStatus('not-found', 'inactive'), [show]],
        [unitStatus('loaded', 'active'), [show]],
        [unitStatus('loaded', 'failed'), [show, startLocal, show]],
    ]) {
        const calls = [];
        prepareRestartLocalCells('test-restart', (...call) => {
            calls.push(call);
            return calls.length === 1 ? initial : unitStatus('loaded', 'active');
        });
        assert.deepEqual(calls, expected);
    }
    assert.throws(() => prepareRestartLocalCells('test-restart', () => unitStatus('loaded', 'failed')),
        {code: 'CELLS_LOCAL_NOT_ACTIVE', message: /^cells\.local\.start:/});
});

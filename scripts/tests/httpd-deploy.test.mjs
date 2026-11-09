import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deployHttpd} from '../httpd-deploy.mjs';
function fixture() {
    const calls = [], logs = [], state = {serviceId: 'service', currentRelease: 'before', desiredState: 'running', args: []};
    const ports = {read: async () => state, alive: async () => true, health: () => async version => {calls.push(['health', version]); return true;},
        switch: async args => {calls.push(['switch', args]);}, log: row => logs.push(row)};
    const build = async args => {calls.push(['build', args]); return 'after';};
    return {calls, logs, state, ports, build, run: (args = []) => deployHttpd('/source', '/releases', args, build, ports)};
}
test('builds without activation and fences switching with the pre-build service and version', async () => {
    const f = fixture(); await f.run(['--no-cache']);
    assert.deepEqual(f.calls.map(row => row[0]), ['health', 'build', 'switch', 'health']);
    assert.deepEqual(f.calls[1], ['build', ['--no-cache', '--no-activate']]);
    const values = f.calls[2][1]; assert.equal(values[0], 'after');
    assert.equal(values[values.indexOf('--expected-current') + 1], 'before');
    assert.equal(values[values.indexOf('--service-id') + 1], 'service');
    assert.equal(values[values.indexOf('--operation-id') + 1], f.logs[0].operationId);
    assert.deepEqual(f.logs.at(-1), {...f.logs.at(-1), stage: 'health', result: 'success', version: 'after'});
});
test('does not switch when build fails and records the failed stage', async () => {
    const f = fixture(); const build = async () => {throw Object.assign(new Error('build failed'), {code: 'BUILD_FAILED'});};
    await assert.rejects(deployHttpd('/source', '/releases', [], build, f.ports), {code: 'BUILD_FAILED'});
    assert.equal(f.calls.some(row => row[0] === 'switch'), false); assert.equal(f.logs.at(-1).stage, 'build');
});
test('refuses to deploy over a changed version and preserves the switch failure', async () => {
    const f = fixture(); f.ports.switch = async () => {throw Object.assign(new Error('changed'), {code: 'HTTPD_VERSION_CHANGED'});};
    await assert.rejects(f.run(), {code: 'HTTPD_VERSION_CHANGED'});
    assert.equal(f.logs.at(-1).stage, 'switch'); assert.equal(f.logs.at(-1).result, 'failure');
});
test('does not build without a healthy running launcher', async () => {
    const f = fixture(); f.ports.alive = async () => false;
    await assert.rejects(f.run(), {code: 'HTTPD_LAUNCHER_NOT_RUNNING'}); assert.equal(f.calls.length, 0);
    f.ports.alive = async () => true; f.ports.health = () => async () => false;
    await assert.rejects(f.run(), {code: 'HTTPD_HEALTH_CHECK_FAILED'}); assert.equal(f.calls.length, 0);
});
test('does not report successful deployment if the final runtime version is unhealthy', async () => {
    const f = fixture(); f.ports.health = () => async version => version === 'before';
    await assert.rejects(f.run(), {code: 'HTTPD_HEALTH_CHECK_FAILED'});
    assert.equal(f.logs.at(-1).stage, 'health'); assert.equal(f.logs.at(-1).result, 'failure');
});
test('rejects activation and unrelated build flags before side effects', async () => {
    const f = fixture(); await assert.rejects(f.run(['--share-main']), {code: 'HTTPD_DEPLOY_INVALID_OPTIONS'}); assert.equal(f.calls.length, 0);
});

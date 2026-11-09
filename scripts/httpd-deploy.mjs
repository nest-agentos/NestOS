import {randomUUID} from 'node:crypto';
import {readLaunch, launcherAlive, launchFailure} from './httpd-launch-state.mjs';
import {launcherCommand} from './httpd-launcher.mjs';
import {launchHealth} from './httpd-launch-health.mjs';

/** Build without activation, then switch the exact service/version observed before the build. */
export async function deployHttpd(root, releases, args, build, overrides = {}) {
    const ports = {read: () => readLaunch(root, 'release'), alive: launcherAlive, health: state => launchHealth(root, state.args, 'release'),
        switch: values => launcherCommand(root, releases, 'switch', values), log: row => console.log('[HTTPDeploy]', JSON.stringify(row)), ...overrides};
    if (args.some(arg => arg !== '--no-cache')) throw launchFailure('HTTPD_DEPLOY_INVALID_OPTIONS');
    const operationId = randomUUID(), started = Date.now(); let stage = 'preflight';
    const report = (result, fields = {}) => ports.log({operation: 'httpd.deploy', operationId, stage, result, durationMs: Date.now() - started, ...fields});
    try {
        report('started'); const state = await ports.read();
        if (!state?.currentRelease || state.desiredState !== 'running' || !await ports.alive(state)) throw launchFailure('HTTPD_LAUNCHER_NOT_RUNNING');
        const health = ports.health(state);
        if (!await health(state.currentRelease)) throw launchFailure('HTTPD_HEALTH_CHECK_FAILED');
        report('success', {version: state.currentRelease});
        stage = 'build'; report('started');
        const version = await build([...args, '--no-activate']); report('success', {version});
        stage = 'switch'; report('started', {version});
        await ports.switch([version, '--operation-id', operationId, '--expected-current', state.currentRelease, '--service-id', state.serviceId]);
        report('success', {version}); stage = 'health'; report('started', {version});
        if (!await health(version)) throw launchFailure('HTTPD_HEALTH_CHECK_FAILED');
        report('success', {version}); return version;
    } catch (error) {report('failure', {code: error.code ?? 'HTTPD_DEPLOY_FAILED'}); throw error;}
}

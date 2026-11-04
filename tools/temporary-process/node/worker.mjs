import {spawn} from 'node:child_process';
import {openSync, closeSync, writeSync, constants} from 'node:fs';
// No target starts before this group leader's identity has been committed.
process.once('disconnect', () => {try {process.kill(-process.pid, 'SIGKILL');} catch {process.exit(1);}});
process.once('message', message => {
    if (message.type !== 'start' || !process.connected) return;
    const fd = openSync(message.output, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const child = spawn('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc', '--', message.command, ...message.args],
        {cwd: message.cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
    let bytes = 0, published = false;
    const publish = result => {if (!published && process.connected) {published = true; process.send({type: 'result', ...result});}};
    const output = chunk => {
        const remaining = Math.max(0, 4 * 1024 * 1024 - bytes);
        if (remaining) writeSync(fd, chunk.subarray(0, remaining)); bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) publish({outcome: 'failed', code: 'TEMP_PROCESS_OUTPUT_LIMIT'});
    };
    child.stdout.on('data', output); child.stderr.on('data', output);
    child.once('spawn', () => {if (process.connected) process.send({type: 'started'});});
    child.once('error', error => publish({outcome: 'failed', code: error.code === 'ENOENT' ? 'TEMP_PROCESS_CONTAINMENT_UNAVAILABLE' : error.code ?? 'TEMP_PROCESS_SPAWN_FAILED'}));
    child.once('close', (exitCode, signal) => {closeSync(fd); publish({outcome: exitCode === 0 ? 'succeeded' : 'failed', ...(exitCode === 0 ? {} : {code: 'TEMP_PROCESS_COMMAND_FAILED'}), exitCode, signal});});
});
if (!process.connected) process.exit(1);

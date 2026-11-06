import {fork} from 'node:child_process';

/** A responsive guardian reaps the whole owned group even if business JavaScript spins forever. */
export function runToolGuardian(): void {
    if (!process.send || !process.argv[1]) throw new Error('TOOL_WORKER_IPC_REQUIRED');
    const graceMs = Number(process.env.NESTOS_TOOL_WORKER_GRACE_MS ?? 20000);
    if (!Number.isInteger(graceMs) || graceMs < 1 || graceMs > 20000) throw new Error('TOOL_WORKER_GRACE_INVALID');
    const worker = fork(process.argv[1], [], {execArgv: process.execArgv, env: {...process.env, NESTOS_TOOL_WORKER_ROLE: 'worker'}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
    let closing = false, forwarding = Promise.resolve();
    const stop = () => {
        if (closing) return; closing = true;
        worker.kill('SIGTERM'); setTimeout(() => finish(), graceMs);
    };
    const forward = (message: object) => {
        forwarding = forwarding.then(() => new Promise<void>(resolve => {
            if (!process.connected) {resolve(); stop(); return;}
            try {process.send!(message, () => resolve());} catch {resolve(); stop();}
        }));
    };
    process.on('message', message => {
        try {if (worker.connected && message !== null && typeof message === 'object') worker.send(message as object, error => {if (error) stop();});} catch {stop();}
    });
    process.on('disconnect', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
    worker.on('message', message => forward(message as object));
    worker.once('error', () => {forward({kind: 'failure', code: 'TOOL_WORKER_START_FAILED'}); void forwarding.finally(finish);});
    worker.once('exit', () => {void forwarding.finally(finish);});
    function finish(): void {
        // The guardian was created as the process-group leader by its owning host.
        if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL');
        else {worker.kill('SIGKILL'); process.exit(0);}
    }
}

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { acquireRunSchedulerLock } from '../src/run-scheduler-lock';
import { resumeCommand, deleteCommand } from '../src/commands';

it.each([false, true])('excludes another scheduler and releases on process exit (kill: %s)', async kill => {
    const root = await mkdtemp(`${tmpdir()}/scheduler-lock-`);
    const directory = `${root}/runs/run`;
    await mkdir(directory, { recursive: true });
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/scheduler-lock-worker.ts', directory], { cwd });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = once(child, 'exit');
    let release: (() => void) | undefined;
    try {
        const ready = await Promise.race([once(child.stdout, 'data'), exited.then(status => { throw new Error(`Lock worker exited before ready: ${JSON.stringify(status)} ${stderr}`); })]);
        expect(String(ready[0])).toBe('locked\n');
        await expect(acquireRunSchedulerLock(directory)).rejects.toThrow('active scheduler');
        // The resume entry must acquire ownership before reading or changing a manifest.
        await expect(resumeCommand('run', { stateDir: root }))
            .rejects.toThrow('active scheduler');
        await writeFile(`${directory}/run.json`, JSON.stringify({ status: 'cancelled' }));
        await expect(deleteCommand('run', { stateDir: root })).rejects.toThrow('active scheduler');
        expect(JSON.parse(await readFile(`${directory}/run.json`, 'utf8')).status).toBe('cancelled');
        if (kill) child.kill('SIGKILL'); else child.stdin.write('release');
        await exited;
        release = await acquireRunSchedulerLock(directory);
        await expect(acquireRunSchedulerLock(directory)).rejects.toThrow('active scheduler');
        release(); release();
        release = await acquireRunSchedulerLock(directory);
        release();
        expect(await deleteCommand('run', { stateDir: root, json: true })).toBe(0);
        await expect(readFile(`${directory}/run.json`)).rejects.toThrow();
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        release?.();
        await rm(root, { recursive: true, force: true });
    }
}, 10_000);

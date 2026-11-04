// @file: apps/cli/tests/tauri-process-tree.test.ts
// Real-machine evidence for the desktop (Tauri) Session Bash runner: it compiles the
// actual Rust module (`apps/tauri-app/src-tauri/src/session_bash.rs` +
// `bash_process.rs`) and cancels a TERM-ignoring process tree inside bwrap.
//
// The CLI-side Node runner already has this evidence (`process-cancel.test.ts`); this
// covers the isolated mode, where cancellation must stop the whole bwrap process group
// rather than just signal it. The child keeps appending to a file, so "no new lines after
// cancel" is host-observable proof that the tree actually stopped.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { compileSessionBashFixture, repo } from './rust-fixture';

const tickCount = async (file: string): Promise<number> => {
    try { return (await readFile(file, 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; }
};

it.skipIf(process.platform !== 'linux')('cancelling the isolated Session runner stops a TERM-ignoring process tree', async () => {
    const directory = await mkdtemp(`${tmpdir()}/tauri-process-tree-`);
    let child: ChildProcess | undefined;
    try {
        await compileSessionBashFixture(`${directory}/runner`);
        // The subshell inherits the ignored SIGTERM, so only a group SIGKILL can stop it.
        const script = "trap '' TERM; (while true; do echo tick >> ticks.txt; sleep 0.1; done) & wait";
        child = spawn(`${directory}/runner`, [repo, directory, script, '1500'], { stdio: ['ignore', 'pipe', 'pipe'] });
        const exited = once(child, 'exit');
        void exited.catch(() => undefined);
        let stdout = '', stderr = '';
        child.stdout!.on('data', data => { stdout += String(data); });
        child.stderr!.on('data', data => { stderr += String(data); });

        // While the Run is live the child must really be producing output.
        await vi.waitFor(async () => expect(await tickCount(`${directory}/ticks.txt`)).toBeGreaterThan(0), { timeout: 1200 });

        const [code] = await exited as [number, NodeJS.Signals | null];
        expect(code).toBe(1);
        expect(stderr, stderr).not.toContain('Bash command cancelled before start');
        const cancelled = /cancelled=(true|false) elapsed_ms=(\d+)/.exec(stdout);
        expect(cancelled?.[1], stdout).toBe('true');
        // Cancellation, not the 30s timeout, ended the command.
        expect(Number(cancelled?.[2])).toBeLessThan(15_000);

        const afterCancel = await tickCount(`${directory}/ticks.txt`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
        expect(await tickCount(`${directory}/ticks.txt`)).toBe(afterCancel);
    } finally {
        if (child && child.exitCode === null && child.signalCode === null) {
            const stopped = once(child, 'exit');
            child.kill('SIGKILL');
            await stopped;
        }
        await rm(directory, { recursive: true, force: true });
    }
}, 180_000);

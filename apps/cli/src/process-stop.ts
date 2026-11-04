import { readdir, readFile } from 'node:fs/promises';

/** Signal only the process group created for this invocation. */
export function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
    if (!pid) return;
    try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

/** Do not confirm cleanup while a group member can still execute or write files. */
export async function stopProcessGroup(pid: number | undefined): Promise<void> {
    if (!pid) return;
    let reported = false;
    for (;;) {
        try {
            signalProcessGroup(pid, 'SIGKILL');
            if (!await groupActive(pid)) return;
        } catch (error) {
            // Unverifiable cleanup remains pending, allowing the Kernel to retain ownership.
            if (!reported) { console.error('Process cleanup is awaiting confirmation', error); reported = true; }
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

async function groupActive(pid: number): Promise<boolean> {
    try { process.kill(process.platform === 'win32' ? pid : -pid, 0); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
    }
    if (process.platform !== 'linux') return true;
    // Orphaned zombies may await reaping by PID 1; they cannot execute or mutate files.
    const entries = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    const states = await Promise.all(entries.map(name => activeMember(name, pid)));
    return states.some(Boolean);
}

async function activeMember(name: string, group: number): Promise<boolean> {
    try {
        const stat = await readFile(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        return Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X';
    } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
        throw error;
    }
}

import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, rename, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {FSError} from '@nestos/vfs-core';
import type {TerminalCommand} from '@nestos/app-contracts/services';
import {privateDirectory} from '../runtime/paths';

const queues = new Map<string, Promise<void>>();
const INIT = `HISTFILE=$NESTOS_TERMINAL_HISTORY_FILE
HISTTIMEFORMAT='%s '
HISTSIZE=10000
HISTFILESIZE=
HISTCONTROL=ignorespace
shopt -s cmdhist lithist histappend
exec 9>>"$NESTOS_TERMINAL_HISTORY_LOCK"
__nestos_history_flush() { local previous=$?; /usr/bin/flock -w 2 -x 9 || { echo 'Terminal history lock unavailable' >&2; return "$previous"; }; history -a || echo 'Terminal history write failed' >&2; /usr/bin/flock -u 9; return "$previous"; }
PROMPT_COMMAND=__nestos_history_flush
trap '__nestos_history_flush; HISTFILE=/dev/null' EXIT
`;
const execFileAsync = promisify(execFile);
const HISTORY_SCAN_BYTES = 64 * 1024 * 1024;

/** Private per-user state, shared by all views in the owning host process. */
export class TerminalStore {
    constructor(private readonly directory: string) {}
    private async directoryPath(): Promise<string> { return privateDirectory(this.directory); }
    private async serial<T>(action: () => Promise<T>): Promise<T> {
        const prior = queues.get(this.directory) ?? Promise.resolve();
        const result = prior.then(action, action);
        const tail = result.then(() => {}, () => {}); queues.set(this.directory, tail);
        try { return await result; } finally { if (queues.get(this.directory) === tail) queues.delete(this.directory); }
    }
    async listCommands(): Promise<TerminalCommand[]> {
        const dir = await this.directoryPath();
        try {
            const handle = await open(path.join(dir, 'commands.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {const info=await handle.stat(); if (!info.isFile() || info.size>32*1024*1024) throw new Error('invalid commands');
                const rows:unknown=JSON.parse(await handle.readFile('utf8')); if (!Array.isArray(rows)) throw new Error('invalid commands'); return rows as TerminalCommand[];}
            finally {await handle.close();}
        }
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new FSError('EIO', 'Cannot read saved terminal commands');}
    }
    async saveCommand(command: TerminalCommand): Promise<void> {
        if (!command || typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(command.id) || typeof command.name !== 'string' || !command.name.trim() || command.name.length > 120 || typeof command.command !== 'string' || !command.command.trim() || Buffer.byteLength(command.command) > 16384)
            throw new FSError('EINVAL', 'Provide a valid name and command of at most 16 KiB');
        const item={id:command.id,name:command.name,command:command.command};
        await this.serial(async () => {const rows = await this.listCommands(); const index = rows.findIndex(row => row.id === command.id);
            if (index < 0) {if (rows.length >= 200) throw new FSError('EINVAL', 'Too many terminal commands'); rows.push(item);} else rows[index] = item;
            await this.save(rows);});
    }
    async deleteCommand(id: string): Promise<void> {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new FSError('EINVAL', 'Invalid terminal command identity');
        await this.serial(async () => {const rows = await this.listCommands(); await this.save(rows.filter(row => row.id !== id));});
    }
    private async save(rows: TerminalCommand[]): Promise<void> {
        const dir = await this.directoryPath(), temp = path.join(dir, `commands-${randomUUID()}.tmp`);
        try {await writeFile(temp, JSON.stringify(rows), {mode: 0o600, flag: 'wx'}); await rename(temp, path.join(dir, 'commands.json'));}
        catch {throw new FSError('EIO', 'Cannot save terminal commands');}
    }
    async prepareHistory(_id: string): Promise<{rc: string; history: string; lock: string}> {
        return this.serial(async () => {
            const dir = await this.directoryPath(), rc = path.join(dir, 'bashrc'), history = path.join(dir, 'history'), lock = path.join(dir, 'history.lock');
            const temporary = `${rc}-${randomUUID()}.tmp`;
            await writeFile(temporary, INIT, {mode: 0o600, flag: 'wx'}); await rename(temporary, rc);
            for (const file of [history, lock]) await ensurePrivateFile(file);
            await execFileAsync('/usr/bin/flock', ['--version']);
            return {rc, history, lock};
        });
    }
    async listHistory(): Promise<string[]> {
        const dir = await this.directoryPath(), history = path.join(dir, 'history'), lock = path.join(dir, 'history.lock');
        let info; try {info=await lstat(history);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error;}
        try {
            if (!info.isFile() || info.isSymbolicLink()) throw new Error('invalid history');
            const lockInfo = await lstat(lock); if (!lockInfo.isFile() || lockInfo.isSymbolicLink()) throw new Error('invalid lock');
            const {stdout} = await execFileAsync('/usr/bin/flock', ['-w', '5', '-s', lock, '/usr/bin/tail', '-c', String(HISTORY_SCAN_BYTES), history], {maxBuffer: HISTORY_SCAN_BYTES + 1024, timeout: 6000});
            const entries = parseHistory(stdout), result:string[] = [];
            for (const command of entries.reverse()) if (command && command !== result.at(-1)) {result.push(command); if (result.length === 30) break;}
            if (result.length < 30 && Buffer.byteLength(stdout) >= HISTORY_SCAN_BYTES) throw new Error('history scan incomplete');
            return result;
        } catch {throw new FSError('EIO', 'Cannot read terminal history; check private storage and history size');}
    }
}
async function ensurePrivateFile(file:string):Promise<void> {
    const handle=await open(file,constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,0o600);
    try {const info=await handle.stat(); if (!info.isFile() || info.uid!==process.getuid?.()) throw new FSError('EACCES', 'Invalid private terminal file'); await handle.chmod(0o600);}
    finally {await handle.close();}
}
function parseHistory(source: string): string[] {
    const matches = [...source.matchAll(/^#(\d+)\n/gm)], result:string[] = [];
    for (let i=0;i<matches.length;i++) {const match=matches[i]!, start=match.index!+match[0].length, end=matches[i+1]?.index ?? source.length;
        const command=source.slice(start,end).replace(/\n$/, ''); if (command) result.push(command);}
    return result;
}

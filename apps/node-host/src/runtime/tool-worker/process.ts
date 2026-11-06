import {fork, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import type {ToolUseContext} from '@nestos/tools';
import type {ToolConnectionAccess} from '@nestos/app-contracts/services';
import {ToolWorkerChannel, workerError, type WorkerPacket} from './channel';
import {workerContext} from './context';
import {toolWorkerBudget, type ToolWorkerPool} from './pool';

export interface ToolWorkerOptions {module: string; executables?: Readonly<Record<string, string>>; connections?: ToolConnectionAccess; graceMs?: number; entry?: URL; group?: ToolWorkerPool}

/** Each invocation owns a process group. Storage and credentials stay behind its private IPC ports. */
export function runToolProcess(options: ToolWorkerOptions, tool: {name: string; version?: string}, phase: 'invoke' | 'reconcile', args: Record<string, unknown>, context: ToolUseContext): Promise<unknown> {
    return toolWorkerBudget.run(context.signal, () => ownToolProcess(options, tool, phase, args, context));
}
async function ownToolProcess(options: ToolWorkerOptions, tool: {name: string; version?: string}, phase: 'invoke' | 'reconcile', args: Record<string, unknown>, context: ToolUseContext): Promise<unknown> {
    context.signal?.throwIfAborted();
    const worker = new WorkerProcess(options, context);
    try {
        const input = {module: options.module, tool: tool.name, version: tool.version ?? '1', phase, args, context: workerContext(context),
            executables: options.executables, ...(options.connections ? {connections: connectionPorts(options.connections, context)} : {})};
        await worker.channel.send({kind: 'bootstrap', value: await worker.channel.peer.expose(input)});
        const value = await worker.result; context.signal?.throwIfAborted(); return value;
    } catch (error) {
        worker.log('execute', 'failure', (error as {code?: string})?.code);
        context.signal?.throwIfAborted(); throw error;
    } finally {await worker.close();}
}
function spawnWorker(options: ToolWorkerOptions): ChildProcess {
    const source = import.meta.url.endsWith('.ts'), entry = options.entry ?? new URL(source ? './bootstrap.ts' : './tool-worker.js', import.meta.url);
    const loader = source ? createRequire(new URL('../../../../http-app/package.json', import.meta.url)).resolve('tsx/esm') : undefined;
    try {return fork(entry, [], {execArgv: loader ? ['--import', pathToFileURL(loader).href] : [], env: {...process.env, NESTOS_TOOL_WORKER_ROLE: 'guardian', NESTOS_TOOL_WORKER_GRACE_MS: String(options.graceMs ?? 20000)}, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: process.platform !== 'win32'});}
    catch {throw workerError('TOOL_WORKER_START_FAILED');}
}
class WorkerProcess {
    readonly channel: ToolWorkerChannel;
    readonly result: Promise<unknown>;
    private readonly child: ChildProcess;
    private readonly exited: Promise<void>;
    private readonly operationId: string;
    private readonly started = Date.now();
    private readonly graceMs: number;
    private timer?: ReturnType<typeof setTimeout>;
    constructor(options: ToolWorkerOptions, private readonly context: ToolUseContext) {
        this.operationId = context.operationId ?? randomUUID(); this.graceMs = options.graceMs ?? 20000;
        this.child = spawnWorker(options);
        this.exited = new Promise(resolve => {this.child.once('exit', () => resolve()); this.child.once('error', () => resolve());});
        const pending = workerReplies(this.child); this.channel = pending.channel; this.result = pending.result;
        void this.result.catch(() => {}); context.signal?.addEventListener('abort', this.stop, {once: true});
        if (context.signal?.aborted) this.stop(); this.log('start', 'success');
    }
    private stop = (): void => {
        if (this.timer) return;
        signal(this.child, 'SIGTERM');
        this.timer = setTimeout(() => {this.log('force-stop', 'failure'); signal(this.child, 'SIGKILL');}, this.graceMs);
    };
    async close(): Promise<void> {
        this.context.signal?.removeEventListener('abort', this.stop);
        if (this.child.connected) await this.channel.send({kind: 'shutdown'}).catch(() => {});
        this.timer ??= setTimeout(() => {this.log('force-stop', 'failure'); signal(this.child, 'SIGKILL');}, this.graceMs);
        await this.exited; clearTimeout(this.timer); await this.channel.close(); this.log('exit', 'success');
    }
    log(stage: string, result: string, code?: string): void {report(stage, result, this.operationId, this.child.pid, this.started, code);}
}
function workerReplies(child: ChildProcess) {
    let settled = false;
    let channel!: ToolWorkerChannel;
    const result = new Promise<unknown>((resolve, reject) => {
        const receive = (packet: WorkerPacket) => {
            if (settled || !['result', 'failure'].includes(packet.kind)) return; settled = true;
            packet.kind === 'result' && packet.value !== undefined ? resolve(channel.peer.decode(packet.value)) : reject(workerError(packet.code ?? 'TOOL_WORKER_EXECUTION_FAILED'));
        };
        channel = new ToolWorkerChannel({send: (message, done) => {child.send(message, done);}, on: listener => {child.on('message', listener);}, off: listener => {child.off('message', listener);}}, 'server', receive);
        child.once('error', () => {if (!settled) {settled = true; reject(workerError('TOOL_WORKER_START_FAILED'));}});
        child.once('exit', () => {if (!settled) {settled = true; reject(workerError('TOOL_WORKER_EXITED'));}});
    });
    return {channel, result};
}
function signal(child: ChildProcess, name: NodeJS.Signals): void {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {if (process.platform === 'win32') child.kill(name); else process.kill(-child.pid, name);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
}
function connectionPorts(connections: ToolConnectionAccess, context: ToolUseContext) {
    const methods = ['resolve', 'snapshot', 'save', 'remove', 'accessToken', 'verify', 'saveApplication', 'removeApplication', 'beginAuthorization', 'authorizationStatus', 'cancelAuthorization', 'revokeAuthorization'] as const;
    return Object.fromEntries(methods.filter(name => typeof connections[name] === 'function').map(name => [name, (...args: unknown[]) => {
        context.signal?.throwIfAborted(); return (connections[name] as (...args: unknown[]) => unknown).apply(connections, args);
    }]));
}
function report(stage: string, result: string, operationId: string, pid: number | undefined, started: number, code?: string): void {
    console.info('[ToolWorker]', JSON.stringify({operation: 'tool.worker', operationId, stage, result, pid, code: /^[A-Z][A-Z0-9_]{0,79}$/.test(code ?? '') ? code : undefined, durationMs: Date.now() - started}));
}

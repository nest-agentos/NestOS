import {pathToFileURL} from 'node:url';
import {buildTool, type Tool, type ToolUseContext} from '@nestos/tools';
import {z} from 'zod/v4';
import {ToolWorkerChannel, type WorkerPacket} from './channel';

interface Input {module: string; tool: string; version: string; phase: 'invoke' | 'reconcile'; args: Record<string, unknown>;
    context: ToolUseContext; executables?: Record<string, string>; connections?: import('@nestos/app-contracts/services').ToolConnectionAccess}

export function runToolWorker(): void {new ToolWorkerMain();}
class ToolWorkerMain {
    private readonly controller = new AbortController();
    private readonly channel: ToolWorkerChannel;
    private admitted = false;
    private closing = false;
    private disposal?: Promise<void>;
    private tools: Tool[] = [];
    private work?: Promise<void>;
    constructor() {
        if (!process.send) throw new Error('TOOL_WORKER_IPC_REQUIRED');
        this.channel = new ToolWorkerChannel({send: (message, done) => {process.send!(message, undefined, undefined, done);},
            on: listener => {process.on('message', listener);}, off: listener => {process.off('message', listener);}}, 'client', this.receive);
        process.on('SIGTERM', this.stop); process.on('SIGINT', this.stop); process.on('disconnect', this.stop);
    }
    private stop = (): void => {
        if (this.closing) return;
        this.closing = true;
        this.controller.abort(Object.assign(new Error('Tool worker stopping'), {code: 'TOOL_WORKER_STOPPED'}));
        setTimeout(() => {process.exit(1);}, 20000).unref();
        void this.close();
    };
    private close(): Promise<void> {
        return this.disposal ??= (async () => {
            await this.work;
            await Promise.allSettled(this.tools.map(tool => tool.dispose?.()));
            await this.channel.drain();
            if (process.connected) process.disconnect();
            process.exit(0);
        })();
    }
    private receive = (packet: WorkerPacket): void => {
        if (packet.kind === 'shutdown') {this.stop(); return;}
        if (packet.kind !== 'bootstrap' || this.admitted || this.closing || !packet.value) return;
        this.admitted = true; this.work = this.execute(this.channel.peer.decode(packet.value) as Input);
    };
    private async execute(input: Input): Promise<void> {
        try {
            const tool = await this.load(input);
            this.controller.signal.throwIfAborted();
            const pending: Promise<unknown>[] = [], context = this.context(input.context, pending);
            const result = input.phase === 'invoke' ? await tool.call(input.args, context) : await tool.reconcile!(input.args, context);
            await Promise.all(pending);
            await this.channel.send({kind: 'result', value: await this.channel.peer.expose(result)});
        } catch (error) {
            const raw = (error as {code?: unknown})?.code;
            const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'TOOL_WORKER_EXECUTION_FAILED';
            await this.channel.send({kind: 'failure', code}).catch(() => {});
        }
    }
    private async load(input: Input): Promise<Tool> {
        for (const [key, value] of Object.entries(input.executables ?? {})) process.env[key] = value;
        const module = await import(/* @vite-ignore */ pathToFileURL(input.module).href);
        const connections = input.connections ? {...input.connections, register: () => {}, prepareRegistration: () => ({commit() {}, rollback() {}}), close: undefined} : undefined;
        this.tools = await module.createTools({buildTool, z, connections, executables: input.executables ? Object.freeze(input.executables) : undefined});
        const tool = this.tools.find(tool => tool.name === input.tool && (tool.version ?? '1') === input.version);
        if (!tool) throw Object.assign(new Error('Worker tool unavailable'), {code: 'TOOL_WORKER_TOOL_CHANGED'});
        return tool;
    }
    private context(input: ToolUseContext, pending: Promise<unknown>[]): ToolUseContext {
        const context = {...input, signal: this.controller.signal, abortController: this.controller};
        if (input.setAppState) context.setAppState = (key, value) => {
            (context.appState ??= {})[key] = value;
            const write = Promise.resolve(input.setAppState!(key, value));
            void write.catch(() => {}); pending.push(write);
        };
        return context;
    }
}

import {randomUUID} from 'node:crypto';
import {RpcPeer, type Call, type Reply, type WireValue, type CapabilityRegistry} from '@nestos/app-transport/rpc';

export interface WorkerEndpoint {
    send(message: object, done: (error: Error | null) => void): void;
    on(listener: (message: unknown) => void): void;
    off(listener: (message: unknown) => void): void;
}
export interface WorkerPacket {kind: string; id?: string; call?: Call; reply?: Reply; value?: WireValue; code?: string}
const schemas: CapabilityRegistry = {
    ToolWorkerFiles: {markers: ['readFile', 'writeFile', 'listFiles'], fields: [], methods: {
        readFile: 'async', writeFile: 'async', listFiles: 'async', readBinaryFile: 'async', writeBinaryFile: 'async', stat: 'async', walkFiles: 'iterator'}},
};

/** A private fork channel carries explicit capabilities, never reflected host objects. */
export class ToolWorkerChannel {
    readonly peer: RpcPeer;
    private closed = false;
    private pending = new Map<string, {resolve(reply: Reply): void; reject(error: unknown): void}>();
    private incoming = new Set<Promise<void>>();
    constructor(private readonly endpoint: WorkerEndpoint, side: 'server' | 'client', private readonly receive: (packet: WorkerPacket) => void) {
        this.peer = new RpcPeer(side, call => this.request(call), () => {}, undefined, undefined, schemas);
        endpoint.on(this.message);
    }
    send(packet: WorkerPacket): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.closed) {reject(workerError('TOOL_WORKER_DISCONNECTED')); return;}
            try {this.endpoint.send(packet, error => error ? reject(workerError('TOOL_WORKER_DISCONNECTED')) : resolve());}
            catch {reject(workerError('TOOL_WORKER_DISCONNECTED'));}
        });
    }
    private request(call: Call): Promise<Reply> {
        if (this.pending.size >= 256) return Promise.reject(workerError('TOOL_WORKER_QUEUE_FULL'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            void this.send({kind: 'rpc.call', id, call}).catch(error => {this.pending.delete(id); reject(error);});
        });
    }
    private message = (raw: unknown): void => {
        if (this.closed || !raw || typeof raw !== 'object') return;
        const packet = raw as WorkerPacket;
        if (packet.kind === 'rpc.reply' && packet.id && packet.reply) {
            this.pending.get(packet.id)?.resolve(packet.reply); this.pending.delete(packet.id); return;
        }
        if (packet.kind !== 'rpc.call' || !packet.id || !packet.call) {this.receive(packet); return;}
        const work = this.peer.handle(packet.call).then(reply => this.send({kind: 'rpc.reply', id: packet.id, reply})).catch(() => {});
        this.incoming.add(work); void work.finally(() => this.incoming.delete(work));
    };
    async drain(): Promise<void> {while (this.incoming.size) await Promise.allSettled([...this.incoming]);}
    async close(): Promise<void> {
        this.closed = true; this.endpoint.off(this.message);
        for (const pending of this.pending.values()) pending.reject(workerError('TOOL_WORKER_DISCONNECTED'));
        this.pending.clear(); await this.drain(); await this.peer.close();
    }
}
export function workerError(code: string): Error & {code: string; executionOutcome: 'unknown'} {
    return Object.assign(new Error('Tool execution worker unavailable'), {code, executionOutcome: 'unknown' as const});
}

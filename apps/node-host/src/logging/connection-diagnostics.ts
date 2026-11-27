import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import type {IncomingMessage} from 'node:http';
import type {TLSSocket} from 'node:tls';
import type {AuditPort} from './audit-log';
interface Connection {id:string;started:number;requests:number;remoteAddress?:string;remotePort?:number;secure:boolean;failure?:boolean}
const connections=new WeakMap<Socket,Connection>();
/** Bind HTTP receipts to the actual authenticated socket; never infer ownership from a port. */
export function observeConnection(audit:AuditPort,socket:Socket):string {
    const old=connections.get(socket);if(old)return old.id;
    return trackConnection(audit,socket,true).id;
}
function trackConnection(audit:AuditPort,socket:Socket,secure:boolean):Connection {
    const value:Connection={id:randomUUID(),started:Date.now(),requests:0,remoteAddress:socket.remoteAddress,remotePort:socket.remotePort,secure};connections.set(socket,value);
    socket.once('close',hadError=>{
        if(value.failure||value.requests&&!hadError)return;
        audit.write({event:'connection.closed',operation:'http.connection',operationId:value.id,connectionId:value.id,
            stage:value.secure?'socket.close':'tls.handshake',result:hadError?'failure':'closed',
            code:hadError?'HTTP_CONNECTION_RESET':value.secure?'HTTP_CONNECTION_CLOSED_BEFORE_REQUEST':'TLS_HANDSHAKE_INCOMPLETE',
            remoteAddress:value.remoteAddress,remotePort:value.remotePort,requestCount:value.requests,durationMs:Date.now()-value.started,
            bytesRead:socket.bytesRead,bytesWritten:socket.bytesWritten});
    });
    return value;
}
export function connectionId(request:IncomingMessage):string|undefined {return connections.get(request.socket)?.id;}
export function countConnectionRequest(request:IncomingMessage):void {const value=connections.get(request.socket);if(value)value.requests++;}

/** Only match the complete tuple of a live socket accepted by this server. */
export class ConnectionDiagnostics {
    private readonly pending=new Map<string,Connection>();
    constructor(private readonly audit:AuditPort) {}
    accept(socket:Socket):void {
        const value=trackConnection(this.audit,socket,false),key=tuple(socket);
        if(key){
            this.pending.set(key,value);
            socket.once('close',()=>queueMicrotask(()=>{if(this.pending.get(key)===value)this.pending.delete(key);}));
        }
    }
    secure(socket:TLSSocket):string {
        const value=this.lookup(socket);
        if(!value)return observeConnection(this.audit,socket);
        value.secure=true;return value.id;
    }
    reject(error:Error,socket:TLSSocket):void {
        const value=this.lookup(socket),code=(error as NodeJS.ErrnoException).code;
        if(value)value.failure=true;
        this.audit.write({event:'auth.rejected',operation:'http.connection',stage:'tls.handshake',result:'failure',
            code:typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'TLS_CLIENT_AUTHENTICATION_FAILED',
            connectionId:value?.id,operationId:value?.id,remoteAddress:value?.remoteAddress??socket.remoteAddress,
            remotePort:value?.remotePort??socket.remotePort,durationMs:value?Date.now()-value.started:undefined,
            tlsProtocol:socket.getProtocol()??undefined,sessionReused:socket.isSessionReused(),
            ...tlsErrorMetadata(error)});
    }
    private lookup(socket:Socket):Connection|undefined {
        const parent=(socket as TLSSocket&{_parent?:Socket})._parent;
        const key=tuple(socket),value=connections.get(socket)??(parent?connections.get(parent):undefined)??(key?this.pending.get(key):undefined);
        if(value)connections.set(socket,value);
        return value;
    }
}
function tuple(socket:Socket):string|undefined {
    return socket.remoteAddress&&socket.remotePort&&socket.localAddress&&socket.localPort
        ?JSON.stringify([socket.remoteAddress,socket.remotePort,socket.localAddress,socket.localPort]):undefined;
}
function tlsErrorMetadata(error:Error):{tlsReason?:string;tlsLibrary?:string;syscall?:string} {
    const value=error as Error&{reason?:unknown;library?:unknown;syscall?:unknown};
    const safe=(field:unknown)=>typeof field==='string'&&/^[A-Za-z0-9_ .:-]{1,120}$/.test(field)?field:undefined;
    return {tlsReason:safe(value.reason),tlsLibrary:safe(value.library),syscall:safe(value.syscall)};
}

import {randomUUID} from 'node:crypto';
import type {Socket} from 'node:net';
import type {IncomingMessage} from 'node:http';
import type {AuditPort} from './audit-log';
interface Connection {id:string;started:number;requests:number;remoteAddress?:string;remotePort?:number}
const connections=new WeakMap<Socket,Connection>();
/** Bind HTTP receipts to the actual authenticated socket; never infer ownership from a port. */
export function observeConnection(audit:AuditPort,socket:Socket):string {
    const old=connections.get(socket);if(old)return old.id;
    const value={id:randomUUID(),started:Date.now(),requests:0,remoteAddress:socket.remoteAddress,remotePort:socket.remotePort};connections.set(socket,value);
    socket.once('close',hadError=>{
        if(value.requests&&!hadError)return;
        audit.write({event:'connection.closed',operation:'http.connection',operationId:value.id,connectionId:value.id,
            stage:'socket.close',result:hadError?'failure':'closed',code:hadError?'HTTP_CONNECTION_RESET':'HTTP_CONNECTION_CLOSED_BEFORE_REQUEST',
            remoteAddress:value.remoteAddress,remotePort:value.remotePort,requestCount:value.requests,durationMs:Date.now()-value.started});
    });
    return value.id;
}
export function connectionId(request:IncomingMessage):string|undefined {return connections.get(request.socket)?.id;}
export function countConnectionRequest(request:IncomingMessage):void {const value=connections.get(request.socket);if(value)value.requests++;}

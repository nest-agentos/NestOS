import {EventEmitter} from 'node:events';
import type {Socket} from 'node:net';
import type {TLSSocket} from 'node:tls';
import type {IncomingMessage} from 'node:http';
import {expect,it,vi} from 'vitest';
import {ConnectionDiagnostics,observeConnection,countConnectionRequest,connectionId} from '../../node-host/src/logging/connection-diagnostics';
it('records early socket closure and correlates received requests without logging any content',()=>{
    const write=vi.fn(),audit={write,close:async()=>{}},socket=Object.assign(new EventEmitter(),{remoteAddress:'127.0.0.1',remotePort:12345});
    const id=observeConnection(audit,socket as Socket);expect(observeConnection(audit,socket as Socket)).toBe(id);
    socket.emit('close',false);expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({connectionId:id,stage:'socket.close',code:'HTTP_CONNECTION_CLOSED_BEFORE_REQUEST',requestCount:0}));
    const active=new EventEmitter() as Socket;const second=observeConnection(audit,active),request={socket:active} as IncomingMessage;
    countConnectionRequest(request);expect(connectionId(request)).toBe(second);active.emit('close',false);expect(write).toHaveBeenCalledOnce();
    const failed=new EventEmitter() as Socket;observeConnection(audit,failed);countConnectionRequest({socket:failed} as IncomingMessage);failed.emit('close',true);
    expect(write.mock.calls[1][0]).toMatchObject({code:'HTTP_CONNECTION_RESET',requestCount:1,result:'failure'});
});
function socket(remotePort=12345) {
    return Object.assign(new EventEmitter(),{remoteAddress:'127.0.0.1',remotePort,localAddress:'127.0.0.1',localPort:2000,
        bytesRead:128,bytesWritten:64,getProtocol:()=>null,isSessionReused:()=>false});
}
it('retains pre-handshake source and elapsed time when a reset destroys the TLS address',()=>{
    const write=vi.fn(),diagnostics=new ConnectionDiagnostics({write,close:async()=>{}}),raw=socket();
    diagnostics.accept(raw as unknown as Socket);raw.remoteAddress=undefined as never;raw.remotePort=undefined as never;
    raw.emit('close',true);
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({remoteAddress:'127.0.0.1',remotePort:12345,
        connectionId:expect.any(String),stage:'tls.handshake',code:'HTTP_CONNECTION_RESET',durationMs:expect.any(Number),bytesRead:128}));
});
it('shares one connection ID between accepted transport, authenticated TLS and HTTP receipts',()=>{
    const write=vi.fn(),diagnostics=new ConnectionDiagnostics({write,close:async()=>{}}),raw=socket(),tls=socket();
    diagnostics.accept(raw as unknown as Socket);const id=diagnostics.secure(tls as unknown as TLSSocket),request={socket:tls} as unknown as IncomingMessage;
    countConnectionRequest(request);expect(connectionId(request)).toBe(id);raw.emit('close',true);
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({connectionId:id,stage:'socket.close',requestCount:1}));
});
it('classifies handshake rejection without retaining exception content or duplicating close warnings',()=>{
    const write=vi.fn(),diagnostics=new ConnectionDiagnostics({write,close:async()=>{}}),raw=socket(),tls=socket();
    diagnostics.accept(raw as unknown as Socket);
    diagnostics.reject(Object.assign(new Error('PRIVATE certificate body'),{code:'ECONNRESET',reason:'peer did not return a certificate',library:'SSL routines'}),tls as unknown as TLSSocket);
    raw.emit('close',false);
    expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code:'ECONNRESET',tlsReason:'peer did not return a certificate',connectionId:expect.any(String),durationMs:expect.any(Number)}));
    expect(JSON.stringify(write.mock.calls)).not.toContain('PRIVATE');
});

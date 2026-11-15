import {EventEmitter} from 'node:events';
import type {Socket} from 'node:net';
import type {IncomingMessage} from 'node:http';
import {expect,it,vi} from 'vitest';
import {observeConnection,countConnectionRequest,connectionId} from '../../node-host/src/logging/connection-diagnostics';
it('records early socket closure and correlates received requests without logging any content',()=>{
    const write=vi.fn(),audit={write,close:async()=>{}},socket=Object.assign(new EventEmitter(),{remoteAddress:'127.0.0.1',remotePort:12345});
    const id=observeConnection(audit,socket as Socket);expect(observeConnection(audit,socket as Socket)).toBe(id);
    socket.emit('close',false);expect(write).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({connectionId:id,stage:'socket.close',code:'HTTP_CONNECTION_CLOSED_BEFORE_REQUEST',requestCount:0}));
    const active=new EventEmitter() as Socket;const second=observeConnection(audit,active),request={socket:active} as IncomingMessage;
    countConnectionRequest(request);expect(connectionId(request)).toBe(second);active.emit('close',false);expect(write).toHaveBeenCalledOnce();
    const failed=new EventEmitter() as Socket;observeConnection(audit,failed);countConnectionRequest({socket:failed} as IncomingMessage);failed.emit('close',true);
    expect(write.mock.calls[1][0]).toMatchObject({code:'HTTP_CONNECTION_RESET',requestCount:1,result:'failure'});
});

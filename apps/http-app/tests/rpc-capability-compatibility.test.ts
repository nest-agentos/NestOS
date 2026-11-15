import {expect,it,vi} from 'vitest';
import {RpcPeer} from '../../../shared/app-transport/src/rpc/peer';
import {CAPABILITIES} from '@nestos/app-transport/application';

it('ignores additive methods without exposing them and reports the exact capability only once',async()=>{
    const report=vi.fn(),methods={...CAPABILITIES.KanbanService.methods};delete methods.removeRecordConversations;
    const old={...CAPABILITIES,KanbanService:{...CAPABILITIES.KanbanService,methods}};
    const overview=vi.fn(async()=>({count:1}));let server!:RpcPeer;
    const client=new RpcPeer('client',call=>server.handle(call),report,undefined,undefined,old);
    server=new RpcPeer('server',async()=>({}),undefined,undefined,undefined,CAPABILITIES);
    try {
        const packet=await server.bootstrap({overview,related:async()=>[],scan:async()=>{},execute:async()=>{},removeRecordConversations:async()=>({items:[]})});
        client.applyUpdates(packet.updates);const remote=client.decode(packet.value!);
        expect(remote.removeRecordConversations).toBeUndefined();expect(await remote.overview()).toEqual({count:1});
        expect(report).toHaveBeenCalledOnce();expect(report.mock.calls[0][0]).toMatchObject({code:'RPC_METHOD_UNSUPPORTED',stage:'rpc.decode',capabilityKind:'KanbanService',rpcMethod:'removeRecordConversations'});
        client.applyUpdates(packet.updates);expect(report).toHaveBeenCalledOnce();
    }finally{await client.close();await server.close();}
});
it('cannot execute unregistered remote methods and keeps malformed declarations out of diagnostics',async()=>{
    const report=vi.fn(),client=new RpcPeer('client',async()=>({}),report,undefined,undefined,CAPABILITIES);
    try {
        const descriptor={id:'server:test',kind:'KanbanService',version:1,fields:{$methods:['PRIVATE message body']},snapshots:{},lookups:{}};
        expect(()=>client.decode({$capability:descriptor} as never)).toThrow('Invalid remote method declarations');expect(report).not.toHaveBeenCalled();
    }finally{await client.close();}
});

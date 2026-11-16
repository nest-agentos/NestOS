import {expect,it,vi} from 'vitest';
import {RpcPeer,type CapabilityRegistry} from '@nestos/app-transport/rpc';
const schemas:CapabilityRegistry={Source:{markers:['snapshot','close'],fields:['payload'],methods:{snapshot:'snapshot',close:'async'}}};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function fixture(close:(started:()=>void)=>Promise<void>,blockSnapshot=false){
 let server!:RpcPeer,closed=false,block=false;const started=deferred(),snapshotGate=deferred(),snapshotStarted=deferred(),errors=vi.fn();
 const client=new RpcPeer('client',call=>server.handle(call),errors,undefined,undefined,schemas);
 server=new RpcPeer('server',call=>client.handle(call),errors,undefined,undefined,schemas);
 const payload=new Blob(['payload']),bytes=payload.arrayBuffer.bind(payload);
 vi.spyOn(payload,'arrayBuffer').mockImplementation(async()=>{if(block){snapshotStarted.resolve();await snapshotGate.promise;}return bytes();});
 const source={payload,snapshot:()=>{if(closed)throw new Error('Conversation view closed');return {active:true};},close:async()=>close(()=>{closed=true;started.resolve();})};
 const initial=await server.bootstrap(source);client.applyUpdates(initial.updates);const remote=client.decode(initial.value!);
 return {server,client,remote,errors,failSnapshot:()=>{closed=true;},started,snapshotGate,snapshotStarted,refresh:()=>{block=blockSnapshot;server.invalidate('static');return server.refresh();},dispose:async()=>{snapshotGate.resolve();await client.close();await server.close();}};
}
it('keeps a closing capability out of background snapshot refresh until disposal settles',async()=>{
 const gate=deferred(),f=await fixture(async started=>{started();await gate.promise;});
 try {const closing=f.remote.close();await f.started.promise;
  await expect(f.refresh()).resolves.toEqual([]);gate.resolve();await closing;
  await expect(f.server.refresh()).resolves.toBeDefined();expect(f.errors).not.toHaveBeenCalled();
 }finally{gate.resolve();await f.dispose();}
});
it('discards an in-flight snapshot that races with capability closure',async()=>{
 const gate=deferred(),f=await fixture(async started=>{started();await gate.promise;},true);
 try {const refresh=f.refresh();await f.snapshotStarted.promise;
  const closing=f.remote.close();await f.started.promise;f.snapshotGate.resolve();
  await expect(refresh).resolves.toEqual([]);gate.resolve();await closing;expect(f.errors).not.toHaveBeenCalled();
 }finally{gate.resolve();await f.dispose();}
});
it('restores snapshot refresh after a rejected close and still reports genuine snapshot errors',async()=>{
 const f=await fixture(async()=>{throw Object.assign(new Error('Close rejected'),{code:'CLOSE_REJECTED'});});
 try {await expect(f.remote.close()).rejects.toMatchObject({code:'CLOSE_REJECTED'});
  await expect(f.refresh()).resolves.toBeDefined();expect(f.remote.snapshot()).toEqual({active:true});
  f.failSnapshot();await expect(f.refresh()).rejects.toThrow('Snapshot encoding failed');
 }finally{await f.dispose();}
});

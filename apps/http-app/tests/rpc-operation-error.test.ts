import { expect, it } from 'vitest';
import { RpcPeer } from '@nestos/app-transport/application';

it.each(['unknown','partial','not-committed'] as const)('preserves safe operation identity and %s outcome across RPC', async outcome => {
    const server=new RpcPeer('server',async()=>({})), client=new RpcPeer('client',call=>server.handle(call));
    try {
        const packet=await server.bootstrap({query:async()=>{throw Object.assign(new Error('Write requires reconciliation'), {
            code:'EIO',remoteCode:'FILE_COMMIT_WORKER_LOST',operationId:'original-operation',outcome});}});
        client.applyUpdates(packet.updates); const remote=client.decode(packet.value!) as {query():Promise<unknown>};
        await expect(remote.query()).rejects.toMatchObject({operationId:'original-operation',outcome,remoteCode:'FILE_COMMIT_WORKER_LOST'});
    } finally {await client.close();await server.close();}
});

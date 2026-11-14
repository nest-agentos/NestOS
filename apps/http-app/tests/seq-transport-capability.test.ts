import {expect,it} from 'vitest';
import {createFileSystemSource} from '@nestos/vfs-core';
import {MemoryBackend} from '@nestos/vfs-core/testing';
import {RpcPeer} from '@nestos/app-transport/application';

it('does not advertise host-only structured controls on an application RPC filesystem', async () => {
    const source = await createFileSystemSource({backend:new MemoryBackend(),viewId:'structured-host'});
    const server = new RpcPeer('server',async () => ({}));
    const client = new RpcPeer('client',call => server.handle(call));
    try {
        expect(source.fs.capabilities.structuredSeqFiles).toBe(true);
        const packet = await server.bootstrap({files:source.fs});
        client.applyUpdates(packet.updates);
        const root = client.decode(packet.value!) as {files:typeof source.fs};
        expect(root.files.capabilities.structuredSeqFiles).toBe(false);
        expect((await root.files.capabilitiesAt('/')).structuredSeqFiles).toBe(false);
        expect(root.files.meta.seq?.ioctl).toBeUndefined();
    } finally {await client.close(); await server.close(); await source.dispose();}
});

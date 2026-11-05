import {expect,it,vi} from 'vitest';
import {MemoryBackend,createVFS} from '@nestos/vfs-core';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
it('persists independent Cells nodes and deletion without depending on an MCP catalog',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
    const discover=vi.fn(async (connection:{endpoint:string})=>({version:1 as const,httpEndpoint:connection.endpoint,serverId:'node',fileProtocol:'fs-agent-http-v1' as const,harness:true,projects:true}));
    const provider={discover,setCredential:vi.fn(),clearCredential:vi.fn(),open:async():Promise<never>=>{throw new Error('No file access');},dispose:async()=>{}};
    const make=()=>new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});
    let service=make();await service.init();

    try {
        const first=await service.saveConnection({name:'First',endpoint:'https://first.test'},'first');
        await service.saveConnection({name:'Second',endpoint:'https://second.test'},'second');
        expect(service.connections()).toHaveLength(2);expect(discover).toHaveBeenCalledTimes(2);
        await service.removeConnection(first);await service.dispose();
        service=make();await service.init();
        expect(service.connections().map(value=>value.name)).toEqual(['Second']);
        expect(service.connections()[0].projects).toBe(true);
    }finally{await service.dispose();await manager.dispose();}
});

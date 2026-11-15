import { expect, it, vi } from 'vitest';
import { createVFS, MemoryBackend, createFileSystemSource } from '@nestos/vfs-core';
import { ProjectRemoteMountService } from '../src/projects/remote-mounts';

it('separates WebDAV connection configuration from explicit runtime mounts and preserves native mounts on restart', async () => {
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}), fs=await manager.openFileSystem('/');
    const secrets=new Map<string,string>();
    const source=new MemoryBackend();await source.init();await source.write('/note.md',new TextEncoder().encode('original'));
    const provider={setCredential:(id:string,secret:string)=>{secrets.set(id,secret);},clearCredential:(id:string)=>{secrets.delete(id);},
        discover:vi.fn(async()=>{throw Error('Native discovery must not be required');}),
        discoverDraft:vi.fn(async()=>{throw Error('Native discovery must not be required');}),
        checkDraft:vi.fn(async()=>{}),dispose:async()=>{},
        open:vi.fn(async()=>createFileSystemSource({backend:source,viewId:'dav-fixture',access:'rw'}))};
    const first=new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});
    const second=new ProjectRemoteMountService(fs,provider,async()=>{},async()=>{});
    try {
        await first.init();
        const input={name:'DAV',endpoint:'https://dav.example/dav/docs',protocol:'webdav' as const};
        await first.checkDraft(input,'private-password');
        const id=await first.saveConnection(input,'private-password',undefined,{requireTested:true});
        expect(provider.discover).not.toHaveBeenCalled();expect(provider.discoverDraft).not.toHaveBeenCalled();
        expect(first.connections()).toHaveLength(1);expect(first.list('local')).toEqual([]);expect(provider.open).not.toHaveBeenCalled();
        expect(JSON.stringify(first.connections())).not.toContain('private-password');
        await first.add('local',{connectionId:id,endpoint:'https://ignored.example',alias:'webdav',root:'/',at:'/docs',access:'rw'},'',fs);
        expect(provider.open).toHaveBeenCalledWith(expect.objectContaining({protocol:'webdav',endpoint:input.endpoint,credentialRef:first.connection(id).credentialRef}),undefined);
        expect(secrets.get(first.connection(id).credentialRef)).toBe('private-password');
        const view=await first.compose('local',()=>createFileSystemSource({backend:new MemoryBackend(),viewId:'base'}));
        expect((await view.fs.driver.getChildren('/docs')).map(item=>item.name)).toEqual(['note.md']);await view.dispose();
        await first.saveConnection({...input,anonymous:true},'',id);
        expect(first.list('local').find(m=>m.at==='/docs')?.anonymous).toBe(true);
        await first.add('local',{endpoint:'https://native.example',alias:'docs',root:'/',at:'/native',access:'ro'},'native-secret',fs);
        await second.init();expect(second.connections().find(c=>c.id===id)).toMatchObject(input);
        expect(second.list('local').map(m=>m.at)).toEqual(['/native']);
        await first.remove('local',first.list('local').find(m=>m.at==='/docs')!.mountId);
        expect(first.list('local').map(m=>m.at)).toEqual(['/native']);
    } finally {await first.dispose();await second.dispose();await manager.dispose();}
});

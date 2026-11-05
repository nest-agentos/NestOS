import {it,expect} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {RemoteConversationStore,remoteConversationRecoveryPath} from '../src/projects/remote-conversation-store';
import {ConversationComposerStore} from '../src/projects/conversation-composer-store';
import {memoryClientState} from './helpers/client-state';
it('moves legacy recovery to the remote owner and retains only a content-free local index',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});try{
        const fs=await manager.openFileSystem('/'),key='native',remote=memoryClientState();
        const old=new RemoteConversationStore(fs,key);await old.save({sessionId:'s',draft:'Private draft'});
        const store=new RemoteConversationStore(fs,key,remote);expect((await store.load())?.draft).toBe('Private draft');
        const index=await fs.meta.seq!.getEntry(remoteConversationRecoveryPath,key);
        expect(index).not.toContain('Private draft');expect(JSON.parse(index!)).toMatchObject({remote:true,sessionId:'s'});
        expect(JSON.parse((await remote.read('recovery'))!).draft).toBe('Private draft');
        await store.save({sessionId:'s',draft:'Remote update'});
        expect(await fs.meta.seq!.getEntry(remoteConversationRecoveryPath,key)).not.toContain('Remote update');
    }finally{await manager.dispose();}
});
it('copies the composer to the remote owner before removing the old local input',async()=>{
    const {manager}=await createVFS({rootBackend:new MemoryBackend()});try{
        const fs=await manager.openFileSystem('/'),remote=memoryClientState(),path='/var/lib/projects/project/conversation-input.seq';
        await fs.driver.createFile({parentPath:'/var/lib/projects/project',name:'conversation-input.seq',type:'seqfile',recursive:true});
        const draft={revision:'original',data:'Private input',acceptedOperationIds:['send']};await fs.meta.seq!.setEntry(path,'owner',JSON.stringify(draft));
        const store=new ConversationComposerStore(remote,true,()=>{},{fs,projectId:'project',owner:'owner'});
        expect(await store.readComposerDraft()).toEqual(draft);expect(await fs.meta.seq!.getEntry(path,'owner')).toBeNull();
        expect(JSON.parse((await remote.read('composer'))!)).toEqual(draft);
    }finally{await manager.dispose();}
});

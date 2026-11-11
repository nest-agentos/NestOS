import {it,expect,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {ProjectRemoteMountService} from '../src/projects/remote-mounts';
import {remoteClientState} from '../src/projects/remote-client-state';
import {remoteConversationKey} from '../src/projects/drafts/remote-submission';

it('reads a remote draft receipt with its frozen profile and Cells-owned queue',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});
 try {
  const fs=await manager.openFileSystem('/'),rows=new Map<string,string>();
  const target={connectionId:'connection',serverProjectId:'remote',principalId:'owner',profileId:'codex'};
  const project={id:'remote',revision:1};
  const client={read:vi.fn(async()=>project),close:vi.fn(async()=>{}),queueSession:vi.fn(async()=>({owner:'cells',revision:0,items:[]})),
   clientState:vi.fn(async(_project:unknown,input:any)=>{
    if(input.action==='read')return {value:rows.get(input.key)??null};
    if((rows.get(input.key)??null)!==input.expected)return {applied:false};
    rows.set(input.key,input.value);return {applied:true};
   })};
  const key=remoteConversationKey('local-project',target,'draft');
  await remoteClientState(client as any,project as any,key,()=>{},target.profileId).compare('recovery',null,JSON.stringify({sessionId:'native',submittedTurnId:'done'}));
  const service={store:fs,closed:false,list:()=>[{at:'/',connectionId:'connection',serverProjectId:'remote',serverProjectRevision:1,authorization:{principalId:'owner'}}],
   provider:{projects:()=>client},resolveConnection:async()=>({})};
  const receipt=await ProjectRemoteMountService.prototype.readConversationRecovery.call(service as any,'local-project',target,'draft');
  expect(receipt).toEqual({sessionId:'native',submittedTurnId:'done',pending:false});
  expect(client.queueSession).toHaveBeenCalledWith(project,expect.objectContaining({profileId:'codex',sessionId:'native',action:'read'}));
  expect(client.close).toHaveBeenCalledOnce();
 } finally {await manager.dispose();}
});

import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {developmentCompletedResult} from '../src/presets/kanban-completed-result';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
async function fixture(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 await journal.update('development-workspace:original',()=>({projectId:'project',channelId:'original',policy:{},repositories:[]}));
 await journal.update('worktree:original',()=>({id:'original',directory:'/tree'}));
 const input={dispatch:{id:'recovered',itemId:'item'},item:{id:'item',externalRefs:[{system:'nestos-remote-project',id:'project'}]},originalDispatch:{id:'original',itemId:'item',outcome:'failed'},sessionId:'local-session',nativeSessionId:'native-session'} as any;
 const page={messages:[{id:'final',message:{type:'result',content:'Source handed off'},origin:{sessionId:'native-session',turnId:'later-turn',operationId:'later-operation'}}],execution:{sessionId:'native-session',turnId:'later-turn',operationId:'later-operation',status:'completed'}};
 const verifyDelivery=vi.fn(async()=>{}),remote={sessionChannel:vi.fn(async()=>page)};
 return {journal,input,page,verifyDelivery,remote,port:developmentCompletedResult({journal,verifyDelivery,remote})};
}
it('adopts the completed later publication into a new owned artifact while preserving the failed predecessor',async()=>{
 const f=await fixture(),proof=await f.port.prepare(f.input);expect(proof).toMatchObject({scopeId:'original',resultId:'final',nativeSessionId:'native-session',turnId:'later-turn'});
 const result=await f.port.inspect(f.input,proof);expect(result).toMatchObject({outcome:'succeeded',executionSessionId:'local-session'});
 expect(await f.journal.verify(result.outputs!,'recovered')).toBe(true);expect(f.verifyDelivery).toHaveBeenCalledWith('original');
 expect(f.input.originalDispatch.outcome).toBe('failed');expect(f.remote.sessionChannel.mock.calls.every(call=>call[1]==='messages')).toBe(true);
});
it.each(['origin','turn','session','operation','terminal'] as const)('refuses unverified publication %s evidence',async change=>{
 const f=await fixture();
 if(change==='origin')delete (f.page.messages[0] as any).origin;
 if(change==='turn')f.page.execution.turnId='different-turn';
 if(change==='session')f.page.execution.sessionId='another-session';
 if(change==='operation')f.page.execution.operationId='another-operation';
 if(change==='terminal')f.page.execution.status='cancelled';
 await expect(f.port.prepare(f.input)).rejects.toMatchObject({code:'CONTINUATION_RESULT_UNVERIFIED'});expect(f.verifyDelivery).not.toHaveBeenCalled();
});
it('rechecks source delivery and immutable publication contents before accepting a recovered result',async()=>{
 const f=await fixture(),proof=await f.port.prepare(f.input);f.page.messages[0].message.content='changed';
 await expect(f.port.inspect(f.input,proof)).rejects.toMatchObject({code:'CONTINUATION_RESULT_CHANGED'});
 expect(await f.journal.get('artifact-owner:recovered')).toBeUndefined();
});

import {expect,it} from 'vitest';
import {fixture,request} from './harness-execution-fixture';
import {context} from './harness-context-fixture';
import {ExecutionJournal} from '../src/projects/harness-execution-journal';
import {HarnessContextBindings} from '../src/projects/harness-context-bindings';
import {recoverNativeTerminal} from '../src/projects/harness-terminal-recovery';
async function prepared(){
 const f=fixture(),input={...request,connection:{...request.connection,directory:'tree'},context};f.profile.contextId='stable-namespace';
 const journal=new ExecutionJournal(f.state,f.context,input);await journal.initialize('original-transport');
 const store=new HarnessContextBindings(f.state,f.context.sessionId),id=journal.data.bindingId!,owner=journal.contextOperation();
 await store.claim(id,context,input.connection,owner);
 await store.attach(id,owner.operationId,{nodeConnectionId:input.connection.nodeConnectionId,profileId:'claude',workspaceId:'workspace',sessionId:'native-session',epoch:'stable-namespace'});
 await journal.save({sessionId:'native-session',turnId:'native-turn',operations:{turn:{requestId:'original-turn-request',outcome:'committed',result:{turnId:'native-turn'}}}});
 f.data.epoch='replacement';f.session.cwd='/projects/workspace/tree';f.data.history.turns=[{id:'native-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text:'Verified original output'}]}];
 const run={acquired:await f.connections.acquire(),journal,request:input,signal:f.controller.signal};
 return {...f,run,store,id};
}
it('settles the original context from exact native history without changing its namespace or transport fence',async()=>{
 const f=await prepared();expect(await recoverNativeTerminal(f.run)).toMatchObject({sessionId:'native-session',turnId:'native-turn',text:'Verified original output'});
 expect(f.run.journal.data.epoch).toBe('original-transport');
 const binding=await f.store.get(f.id);expect(binding).toMatchObject({nativeRef:{epoch:'stable-namespace'},knownHeadRef:'native-turn'});expect(binding?.activeOperation).toBeUndefined();
 expect(f.client.create).not.toHaveBeenCalled();expect(f.client.turn).not.toHaveBeenCalled();expect(f.client.resume).not.toHaveBeenCalled();
});
it.each(['namespace','workspace','session','directory','receipt'] as const)('rejects changed %s evidence rather than settling or resending',async change=>{
 const f=await prepared();
 if(change==='namespace')f.profile.contextId='other-namespace';
 if(change==='workspace')f.run.acquired.workspaceId='other-workspace';
 if(change==='session')f.data.history.session={...f.session,id:'other-session'};
 if(change==='directory')f.data.history.session={...f.session,cwd:'/different/tree-owner'};
 if(change==='receipt')await f.run.journal.save({operations:{turn:{requestId:'original-turn-request',outcome:'pending'}}});
 const codes={namespace:'CONTEXT_NATIVE_EPOCH_CHANGED',workspace:'CONTEXT_NATIVE_SCOPE_CHANGED',session:'NATIVE_SESSION_MISMATCH',directory:'CONTEXT_NATIVE_SCOPE_CHANGED',receipt:'NATIVE_EPOCH_CHANGED'};
 await expect(recoverNativeTerminal(f.run)).rejects.toMatchObject({code:codes[change]});
 expect(f.run.journal.data.result).toBeUndefined();expect(f.client.create).not.toHaveBeenCalled();expect(f.client.turn).not.toHaveBeenCalled();
});

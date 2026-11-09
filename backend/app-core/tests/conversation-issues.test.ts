import {expect,it,vi} from 'vitest';
import {readConversationIssues} from '../src/run/conversation-issues';
import type {PromptJournal} from '../src/run/prompt-bundle';
function fixture(){
 const data=new Map<string,unknown>(),rows:any[]=[];
 const journal:PromptJournal={get:async<T>(key:string)=>structuredClone(data.get(key)) as T|undefined,update:async<T>(key:string,change:(old:T|undefined)=>T)=>{const next=change(structuredClone(data.get(key)) as T|undefined);data.set(key,structuredClone(next));return next;}};
 const remote={sessionChannel:vi.fn(async(_p:string,operation:string)=>operation==='messages'?{messages:structuredClone(rows)}:{})};
 const report=(id:string,type:string,turnId:string,replyTo?:string,sessionId='s')=>rows.push({id,message:{type,content:'Checked evidence',...(replyTo?{replyTo}:{})},origin:{sessionId,turnId,operationId:'op-'+turnId}});
 return {rows,report,remote,read:()=>readConversationIssues(remote,'project','scope','s',journal)};
}
it('retains recoverable decision issues across reads and clears only linked resolutions',async()=>{
 const f=fixture();f.report('error','error','a');
 expect(await f.read()).toMatchObject({state:'blocked',pendingReports:[{id:'error',type:'error'}]});
 f.report('progress','progress','b');expect(await f.read()).toMatchObject({state:'blocked'});
 f.report('foreign','resolved','b','error','other');expect(await f.read()).toMatchObject({state:'blocked'});
 f.report('fixed','resolved','b','error');expect(await f.read()).toEqual({code:undefined,pendingReports:[]});
 expect(await f.read()).toEqual({code:undefined,pendingReports:[]});
 expect(f.remote.sessionChannel.mock.calls.filter(call=>call[1]==='acknowledge')).toHaveLength(3);
});
it('permits verified self-repair of errors but requires another turn for clarification',async()=>{
 const f=fixture();f.report('error','error','a');f.report('fixed','resolved','a','error');
 expect(await f.read()).toMatchObject({pendingReports:[]});
 f.report('question','clarification','a');f.report('self-answer','resolved','a','question');
 expect(await f.read()).toMatchObject({state:'blocked',pendingReports:[{id:'question'}]});
 f.report('answer','resolved','b','question');expect(await f.read()).toMatchObject({pendingReports:[]});
});
it('freezes publication identity and rejects missing or mutated reports',async()=>{
 const f=fixture();f.report('error','error','a');await f.read();
 f.rows[0].message.content='mutated';await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_MESSAGE_CHANGED'});
 f.rows.length=0;await expect(f.read()).rejects.toMatchObject({code:'CHANNEL_MESSAGE_MISSING'});
});
it('rejects reports from another session and retries uncertain acknowledgements',async()=>{
 const f=fixture();f.report('error','error','a',undefined,'other');
 await expect(f.read()).rejects.toMatchObject({code:'CONVERSATION_SOURCE_UNVERIFIED'});
 const g=fixture();g.report('error','error','a');const normal=g.remote.sessionChannel.getMockImplementation()!;let once=true;
 g.remote.sessionChannel.mockImplementation(async(...args)=>{const result=await normal(...args);if(args[1]==='acknowledge'&&once){once=false;throw Error('NETWORK');}return result;});
 await expect(g.read()).rejects.toThrow('NETWORK');expect(await g.read()).toMatchObject({state:'blocked'});
});

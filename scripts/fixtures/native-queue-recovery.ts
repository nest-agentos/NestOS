import {HarnessConversation} from '../../libraries/cells-driver/src/harness/conversation';
import type {HarnessClient, HarnessProfile, HarnessSession} from '../../libraries/cells-driver/src/harness/contracts';
import type {HarnessRecovery} from '../../libraries/cells-driver/src/harness/conversation-journal';
import {NativeInstructionQueuePanel} from '../../ui/llm-ui-adapter/src/components/NativeInstructionQueuePanel';
import {nativeQueueNotice} from '../../ui/llm-ui-adapter/src/independent/native-queue-messages';
const wait=async(ready:()=>boolean)=>{for(let i=0;i<1000;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('QUEUE_NOT_READY');};
async function run(){
 const automatic=location.hash==='#system-recovery';
 const profile:HarnessProfile={id:'native',kind:'codex',workspaces:[{id:'project'}],capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true,executionRecovery:true}};
 let session:HarnessSession={id:'session',title:'中断会话恢复验收',cwd:'/project',status:'notLoaded',resumable:true,updatedAt:1,owned:false,loaded:false};
 let record:HarnessRecovery={sessionId:'session',instructionQueue:{owner:'cells',revision:2,paused:false,receipts:[{id:'original',input:'a'.repeat(64),turnId:'old-turn'}],
  items:[{id:'original',text:'原开发指令（不会重发）',attachments:[],createdAt:Date.now(),state:'dispatching',receipt:{turnId:'old-turn'}}]}};
 const detached=()=>{const checkedAt=Date.now();return {...session,writerLock:{status:'not-held' as const,checkedAt},executionRecovery:{state:'detached' as const,checkedAt,runtimeId:'a'.repeat(32),processId:10,childPid:11,runtimeStartedAt:1,
  ...(automatic?{interruptedTurns:[{turnId:'old-turn',requestId:'original',previousEpoch:'old-node',recoveredAt:checkedAt-1,reason:'CELLS_RESTARTED' as const}]}:{})}};};
 const calls:string[]=[],sent:string[]=[];let saves=0;
 const call=<T>(name:string,value:()=>T)=>{calls.push(name);return Promise.resolve(value());};
 const client={profiles:()=>call('profiles',()=>({epoch:'epoch',profiles:[profile]})),read:()=>call('history',()=>({session:session.owned?session:detached(),turns:[]})),
  inspect:()=>call('inspect',()=>({session:session.owned?session:detached()})),eventSnapshot:()=>call('events',()=>({epoch:'events',cursor:0,gap:false,events:[],requests:[]})),subscribe:()=>()=>{},
  resume:()=>call('resume',()=>({session:session={...session,owned:true,loaded:true,status:'idle'}})),
  turn:(_p:string,_s:string,text:string)=>call('turn',()=>{sent.push(text);session={...session,status:'active',activeTurnId:'new-turn'};return {turnId:'new-turn'};}),
  close:async()=>{},list:async()=>{},create:async()=>{},interrupt:async()=>{},respond:async()=>{},operation:async()=>{}} as unknown as HarnessClient;
 // This fixture simulates the Cells API; Rust integration tests verify recovery decisions.
 const recover=()=>{const queue=record.instructionQueue!,head=queue.items.shift()!;queue.recoveries=[{id:head.id,turnId:head.receipt!.turnId!,outcome:'unknown',recoveredAt:Date.now(),evidence:detached().executionRecovery,...(automatic?{source:'system-restart' as const}:{})}];queue.paused=!automatic;queue.revision++;};
 const advance=async()=>{const queue=record.instructionQueue!;
  if(automatic&&queue.items[0]?.id==='original')recover();
  const head=queue.items[0];if(queue.paused||head?.state!=='pending'||session.activeTurnId)return;
  await client.resume(profile.id,session.id);const result=await client.turn(profile.id,session.id,head.text,head.attachments);head.state='dispatching';head.receipt={turnId:result.turnId};queue.revision++;
 };
 const conversation=new HarnessConversation(client,profile,'project','session',true,{epoch:'epoch',
  load:async()=>{calls.push('queue.read');await advance();return structuredClone(record);},
  save:async next=>{saves++;const queue=record.instructionQueue;record=structuredClone(next);record.instructionQueue=queue;},
  recoverSession:async request=>{calls.push('session.recover');if(record.instructionQueue!.revision!==request.expectedRevision||record.instructionQueue!.items[0]?.id!==request.instructionId)throw Error('RECOVERY_SCOPE_CHANGED');recover();},
  instructions:{enqueue:async item=>{calls.push('queue.enqueue');const queue=record.instructionQueue!;if(!queue.receipts.some(row=>row.id===item.id)){queue.items.push(item);queue.receipts.push({id:item.id,input:'b'.repeat(64)});queue.revision++;}await advance();return structuredClone(queue);},
   edit:async edit=>{calls.push('queue.edit');const queue=record.instructionQueue!;if(edit.expectedRevision!==queue.revision)throw Error('REVISION_CONFLICT');if(edit.action!=='resume'&&edit.action!=='pause')throw Error('FIXTURE_EDIT_UNSUPPORTED');queue.paused=edit.action==='pause';queue.revision++;await advance();return structuredClone(queue);}}
 });
 const editor=document.getElementById('editor')!;editor.innerHTML='<h1>中断会话恢复</h1><p data-notice></p><section data-queue></section>';
 const update=async(s:Awaited<ReturnType<typeof conversation.read>>)=>{editor.querySelector('[data-notice]')!.textContent=nativeQueueNotice(s)?.message??'队列已恢复';panel.update(s);};
 const controls={read:()=>conversation.read(),editInstructionQueue:async(edit:Parameters<typeof conversation.editInstructionQueue>[0])=>{await conversation.editInstructionQueue(edit);return conversation.refresh();}};
 const panel=new NativeInstructionQueuePanel(editor.querySelector('[data-queue]')!,controls,update);
 const metrics:any[]=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{calls.length=0;const started=performance.now();await action();await wait(ready);
  const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 if(automatic){
  record.instructionQueue!.items.push({id:'next',text:'已排队的后续输入',attachments:[],createdAt:Date.now(),state:'pending'});
  record.instructionQueue!.receipts.push({id:'next',input:'b'.repeat(64)});
  await measure('cold.open-after-cells-restart',async()=>{await conversation.read();await update(conversation.snapshot());},()=>!!record.instructionQueue!.recoveries?.length);
  if(record.instructionQueue!.recoveries![0].outcome!=='unknown'||record.instructionQueue!.paused||record.instructionQueue!.items.some(row=>row.id==='original'))throw Error('SYSTEM_RECOVERY_NOT_PERSISTED');
  await measure('warm.dispatch-existing-followup',async()=>{await conversation.refresh();await update(conversation.snapshot());},()=>!!record.instructionQueue!.items[0]?.receipt?.turnId);
  if(sent.length!==1||sent[0]!=='已排队的后续输入'||record.instructionQueue!.items[0].receipt?.turnId!=='new-turn')throw Error('SYSTEM_RECOVERY_REPLAYED_OR_BLOCKED');
  await conversation.close();panel.destroy();
  editor.innerHTML='<h1>系统异常恢复验收通过</h1><p>Cells 持久证据解除旧屏障，原轮记为未知；只发送原已排队输入。</p>';
  document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual driver and queue DOM; simulated Cells authority API, no HTTP transport',dataset:{sessions:1,acceptedTurns:1,pendingInstructions:1,backgroundLoad:'none'},metrics,saves});
  return;
 }
 await measure('cold.open-detached-session',async()=>{await conversation.read();await conversation.enqueue('现在是否已经完成？',[],undefined,'next');await update(conversation.snapshot());},()=>editor.textContent!.includes('需要恢复'));
 if(!conversation.snapshot().instructionQueue?.recovery?.required||sent.length)throw Error('DETACHMENT_NOT_PROJECTED');
 const click=(action:string)=>editor.querySelector<HTMLButtonElement>('[data-action="'+action+'"]')!.click();
 click('toggle');click('recover');if(record.instructionQueue!.recoveries?.length)throw Error('CONFIRMATION_BYPASSED');
 await measure('warm.confirm-recovery',()=>click('recover'),()=>!!record.instructionQueue!.recoveries?.length&&record.instructionQueue!.paused);
 if(sent.length||record.instructionQueue!.recoveries![0].outcome!=='unknown')throw Error('UNKNOWN_TURN_REPLAYED');
 await wait(()=>{const button=editor.querySelector<HTMLButtonElement>('[data-action="resume"]');return !!button&&!button.disabled;});
 await measure('warm.resume-queued-message',()=>click('resume'),()=>!!record.instructionQueue!.items[0]?.receipt?.turnId);
 if(sent.length!==1||sent[0]!=='现在是否已经完成？'||record.instructionQueue!.items[0].receipt?.turnId!=='new-turn')throw Error('QUEUED_INPUT_NOT_RESUMED');
 await conversation.close();panel.destroy();
 editor.innerHTML='<h1>中断会话恢复验收通过</h1><p>旧轮次结果未知，未重发；用户确认恢复后，仅发送原已排队消息。</p>';
 document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual driver and queue DOM; simulated Cells authority API, no HTTP transport',dataset:{sessions:1,acceptedTurns:1,pendingInstructions:1,backgroundLoad:'none'},metrics,saves});
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

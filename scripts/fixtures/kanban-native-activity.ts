import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore} from '@nestos/kanban';
import {createKanbanActivityModule} from '@nestos/kanban/activity';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import {nativeSessionActivity} from '../../backend/app-core/src/kanban/native-session-activity';
import {createLocalKanbanSessionSource} from '../../backend/app-core/src/kanban/session-source';
const wait=async(ready:()=>boolean)=>{for(let i=0;i<1000;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI_NOT_READY');};
async function run(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/'),journal=new KanbanAutomationJournal(fs);await journal.open();
 const native=nativeSessionActivity(journal),oldTime=Date.now()-3600000,eventTime=Date.now()-1000;
 const source=createLocalKanbanSessionSource({getManifest:async()=>({id:'internal',title:'原执行会话',currentBranch:'main',createdAt:oldTime})} as never,{sessionActivity:async()=>({sessionId:'internal',sessionStatus:'open',counts:{},pending:{},latestExit:{status:'succeeded',at:oldTime},lastActivityAt:oldTime})} as never,async()=>'/folder:project/@harness/codex/native',native.read);
 const service=createKanbanActivityModule({store:await SeqKanbanStore.open(fs),actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){},referenceSystem:'nestos-execution-session',executionSessions:{source}});
 await service.create({id:'board',title:'同一会话续办状态验收',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'owner',responsibility:'Work',roles:['coordinator','reviewer','worker']}]});
 let seq=0;const command=async(command:any)=>service.execute('board',{operationId:'seed-'+ ++seq,expectedRevision:(await service.read('board')).revision,command});
 await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,items:[{id:'task',title:'原会话续办执行任务',responsibility:'Work',acceptance:'Verified',assignee:{kind:'human',id:'owner'},dependsOn:[]}]}});
 await command({type:'prepare-dispatch',itemId:'task',dispatchId:'dispatch'});
 await command({type:'link-reference',itemId:'task',reference:{system:'nestos-execution-session',id:'internal',revision:'dispatch'}});
 await command({type:'observe-execution',dispatchId:'dispatch',fence:(await service.workflow('board')).dispatches.dispatch.fence,outcome:'running',executionSessionId:'internal'});
 await native.record('board','internal',{sessionId:'native',turnId:'later',status:'running',observedAt:eventTime});
 let calls:string[]=[];const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board/task',selected(){},openSession:async()=>{},presentation:{text:key=>(zhCN as Record<string,string>)['kanban.'+key]??key,icons:{close:'×',more:'…',refreshView:'↻'}}});
 const metrics:any[]=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,state:string)=>{calls=[];const started=performance.now();await action();await wait(()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-execution-state="'+state+'"]'));const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-retained-execution-session',()=>view.start(),'running');
 if((await service.executionSession('board','task')).current?.lastActivityAt!==eventTime)throw Error('STALE_ACTIVITY_TIME');
 await native.record('board','internal',{sessionId:'native',turnId:'later',status:'completed',observedAt:eventTime+1});
 await measure('warm.end-native-turn',()=>view.invalidateFromEvents(),'completed');
 if(!editor.textContent?.includes('本轮执行已结束')||(await service.item('board','task')).task?.phase!=='running')throw Error('TURN_COMPLETION_SETTLED_TASK');
 await native.record('board','internal',{sessionId:'native',turnId:'next',status:'running',observedAt:eventTime+2});
 await measure('warm.continue-same-native-session',()=>view.invalidateFromEvents(),'running');
 const result={result:'passed',environment:'Google Chrome headless; actual DOM, MemoryBackend/SeqKanbanStore, native observation adapter and in-process KanbanClient; no HTTP transport',dataset:{boards:1,tasks:1,sessions:1,originalKernelTurn:'completed',laterNativeTurn:'running',backgroundLoad:'none'},metrics};
 document.getElementById('result')!.textContent=JSON.stringify(result);document.body.dataset.acceptance='passed';
 // The bounded browser process owns the preview and its subscriptions.
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

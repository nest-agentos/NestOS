import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanWorkbench} from '@nestos/kanban-ui';

const ref=(id:string)=>({system:'projects',id});
const visible=(root:HTMLElement,selector:string)=>{const node=root.querySelector<HTMLElement>(selector),box=node?.getBoundingClientRect();return !!box&&box.width>40&&box.height>10&&box.top>=0&&box.bottom<=innerHeight;};
const wait=async(ready:()=>boolean)=>{for(let i=0;i<1000;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI_NOT_READY');};
async function run() {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});
 const service=createKanbanModule({store:await SeqKanbanStore.open(await manager.openFileSystem('/')),actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){}});
 await service.create({id:'board',title:'项目决策验收',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Review',roles:['coordinator','reviewer']}]});
 for(let index=0;index<100;index++) {
  const projects=index%4===0?['one','two']:index%2?['one']:['two'];
  await service.execute('board',{operationId:'seed-'+index,expectedRevision:(await service.read('board')).revision,command:{type:'append-record',record:{id:'decision-'+index,kind:'decision',title:'决策 '+index,content:'Requirements '.repeat(128),rationale:'Acceptance',itemIds:[],sources:[],externalRefs:projects.map(ref)}}});
 }
 let serial=0;const command=async(command:any)=>service.execute('board',{operationId:'coord-'+ ++serial,expectedRevision:(await service.read('board')).revision,command});
 await command({type:'create-item',item:{id:'coord',title:'协调任务',purpose:'planning',responsibility:'Plan',acceptance:'Checked'},planning:{kind:'coordination',priority:2,dependencies:[],references:[]}});
 await command({type:'report-analysis',itemId:'coord',operationId:'failed',status:{itemId:'coord',state:'failed',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED'}});
 await command({type:'link-record',recordId:'decision-98',itemId:'coord'});await command({type:'review-record',recordId:'decision-98',accept:true});
 await command({type:'request-record-cancellation',recordId:'decision-96'});await command({type:'cancel-record',recordId:'decision-96'});await command({type:'archive-record',recordId:'decision-96'});
 let sessionBlocked=true;const openedSessions:string[]=[];
 Object.assign(service,{boardSettings:async()=>({fields:['decision','coordination','execution'].map(role=>({name:'harness-'+role,label:role,choices:[{value:'',label:'默认'},{value:'codex',label:'Codex'},{value:'dsh',label:'缺少必要能力',disabled:true}]}))}),openRecordCoordination:async(_board:string,request:any)=>({id:'retained',boardId:'board',recordId:request.recordId,resourceId:'/native/retained',state:'confirmed',createdAt:1}),openTaskCommunication:async()=>({id:'retained',boardId:'board',recordId:'decision-98',resourceId:'/native/retained',state:'confirmed',createdAt:1}),recordConversations:async()=>[
  {id:'linked-discussion',recordId:'decision-98',boardId:'board',state:sessionBlocked?'blocked':'confirmed',createdAt:1,resourceId:'/native/decision-98',sessionId:'original',code:sessionBlocked?'DECISION_SESSION_ERROR_REPORTED':undefined,pendingReports:sessionBlocked?[{id:'error',type:'error'}]:[]},
  {id:'no-session',boardId:'board',state:'error',createdAt:1,code:'ECONFLICT'},
  {id:'draft',boardId:'board',state:'draft',createdAt:Date.now()+2,resourceId:'/native/draft',sessionId:'draft',title:'待确认草稿',resources:[ref('two')]},
  {id:'cancelled-draft',boardId:'board',state:'cancelled',createdAt:Date.now()+4,resourceId:'/native/cancelled',sessionId:'cancelled',title:'已取消的草稿',resources:[ref('two')]},
  {id:'session-error',boardId:'board',state:'error',createdAt:Date.now()+3,resourceId:'/native/failed',sessionId:'failed',title:'接续失败的草稿',code:'EIO',resources:[ref('two')]}],
 recordExecutions:async(_board:string,id:string)=>id==='decision-98'?[{id:'run-0',recordId:id,recordRevision:1,boardId:'board',itemIds:['coord'],stage:'planning',state:'blocked',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',createdAt:1,updatedAt:2}]:[],recordResources:async()=>['one','two'].map(id=>({reference:ref(id),label:id,group:'same-cell'})),startRecordConversation:async()=>{throw Error('UNEXPECTED_CREATION');}});
 let calls:string[]=[];
 const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board/@decision',selected(){},openSession:async id=>{openedSessions.push(id);},presentation:{resourceLabel:reference=>reference.system==='projects'?reference.id:undefined,text:key=>(zhCN as Record<string,string>)['kanban.'+key]??key,icons:{close:'×',more:'…',refreshView:'↻'}}});
 const metrics:Array<{operation:string;durationMs:number;logicalApiCalls:number;httpRequests:number;methods:string[]}>=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{calls=[];const started=performance.now();await action();await wait(ready);const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-decision-list',()=>view.start(),()=>visible(editor,'[data-record-resource]'));
 if(editor.querySelector('[data-context]')?.getAttribute('data-context')!=='decision')throw Error('DECISION_TAB_NOT_FIRST');
 await measure('warm.filter-secondary-project',()=>{const select=editor.querySelector<HTMLSelectElement>('[data-record-resource]')!;select.value=JSON.stringify(ref('two'));select.dispatchEvent(new Event('change',{bubbles:true}));},()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[data-record-resource]')&&view.getActiveResourceId().endsWith('/projects/two'));
 const rows=[...editor.querySelectorAll<HTMLTableRowElement>('[data-decision-row]')],records=[...editor.querySelectorAll<HTMLElement>('[data-record]')];
 if(rows.length!==50||records.some(row=>Number(row.dataset.record!.slice('decision-'.length))%2!==0))throw Error('FILTER_RESULT_MISMATCH');
 if(editor.querySelector('[data-action=toggle-record-archive]')||!editor.querySelector('[data-decision-state=archived]'))throw Error('ARCHIVE_TABLE_STATE_MISMATCH');
 if(!editor.querySelector('[data-decision-state="conversation.draft"]')||!editor.querySelector('[data-decision-state="conversation.error"]')||!editor.querySelector('[data-decision-state="conversation.cancelled"]'))throw Error('DRAFT_TABLE_STATE_MISMATCH');
 if(!editor.querySelector('[data-decision-state=discussion-blocked]'))throw Error('SESSION_ERROR_STATE_MISSING');
 await measure('warm.resolve-decision-session',()=>{sessionBlocked=false;editor.querySelector<HTMLButtonElement>('[data-titlebar-action][data-action=refresh]')!.click();},()=>!editor.hasAttribute('aria-busy')&&!editor.querySelector('[data-decision-state=discussion-blocked]'));
 await measure('warm.enter-failed-task-session',()=>editor.querySelector<HTMLButtonElement>('[data-action=open-task-communication][data-communication-item=coord]')!.click(),()=>!editor.hasAttribute('aria-busy')&&openedSessions.length===1);
 await measure('warm.enter-persistent-coordination',()=>editor.querySelector<HTMLButtonElement>('[data-action=open-record-coordination][data-coordination-record=decision-98]')!.click(),()=>!editor.hasAttribute('aria-busy')&&openedSessions.length===2);
 if(openedSessions.some(id=>id!=='/native/retained'))throw Error('WRONG_COMMUNICATION_SESSION');
 const scroll=editor.querySelector<HTMLElement>('.kanban__decision-scroll')!,box=scroll.getBoundingClientRect();
 if(box.height<180||box.bottom>innerHeight||scroll.scrollHeight<=scroll.clientHeight)throw Error('TABLE_SCROLL_UNUSABLE');
 scroll.scrollTop=scroll.scrollHeight;if(scroll.scrollTop<100)throw Error('TABLE_NOT_SCROLLABLE');scroll.scrollTop=0;
 await measure('warm.next-combined-page',()=>editor.querySelector<HTMLButtonElement>('[data-action=records-next]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===3);
 await measure('warm.first-combined-page',()=>editor.querySelector<HTMLButtonElement>('[data-action=records-first]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===50);
 await measure('warm.open-failed-decision',()=>editor.querySelector<HTMLButtonElement>('[data-record=decision-98]')!.click(),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-decision-failures]'));
 const failures=editor.querySelector('[data-decision-failures]')!;
 if(!failures.textContent?.includes('决策 98')||!failures.textContent.includes('GIT_RELATIVE_WORKTREES_UNSUPPORTED')||!failures.querySelector('[data-item=coord]'))throw Error('DECISION_FAILURE_CONTEXT_MISSING');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.open-new-decision-dialog',()=>editor.querySelector<HTMLButtonElement>('[data-action=new-decision]')!.click(),()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[name=primaryResource]')&&!editor.querySelector<HTMLButtonElement>('[data-form=decision-conversation] button:not([type])')?.disabled);
 if(editor.querySelector<HTMLSelectElement>('[name=primaryResource]')!.value!==JSON.stringify(ref('two')))throw Error('PRIMARY_PREFILL_MISMATCH');
 if((await service.records('board',{includeArchived:true})).total!==100)throw Error('BROWSE_MUTATED_DECISIONS');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.open-board-settings',()=>{const button=editor.querySelector<HTMLButtonElement>('[data-action=board-settings]')!;button.closest('details')?.setAttribute('open','');button.click();},()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[name=setting-harness-decision]'));
 if(editor.querySelectorAll('[data-form=board-settings] select').length!==3)throw Error('SETTINGS_FIELDS_MISSING');
 const selected=editor.querySelector<HTMLSelectElement>('[name=setting-harness-execution]')!;if(!selected.querySelector<HTMLOptionElement>('[value=dsh]')!.disabled)throw Error('UNSUPPORTED_HARNESS_ENABLED');selected.value='codex';
 await measure('warm.save-board-settings',()=>editor.querySelector<HTMLFormElement>('[data-form=board-settings]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 if((await service.read('board')).settings?.['harness-execution']!=='codex')throw Error('SETTINGS_SAVE_MISSING');
 await measure('warm.reopen-board-settings',()=>{const button=editor.querySelector<HTMLButtonElement>('[data-action=board-settings]')!;button.closest('details')?.setAttribute('open','');button.click();},()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLSelectElement>('[name=setting-harness-execution]')?.value==='codex');
 const result={result:'passed',environment:'Google Chrome headless; actual DOM and MemoryBackend/SeqKanbanStore; in-process KanbanClient; no HTTP transport',dataset:{boards:1,decisions:100,archivedDecisions:1,projects:2,relatedDecisions:50,coordinationTasks:1,draftSessions:3,cancelledDrafts:1,hiddenSessionlessFailures:1,backgroundLoad:'none'},metrics};
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 document.body.dataset.acceptance='passed';document.getElementById('result')!.textContent=JSON.stringify(result);(globalThis as any).__kanbanAcceptance=result;
 // Keep the unified table visible for the screenshot; the browser process owns its lifetime.
}
void run().catch(error=>{document.body.dataset.acceptance='failed';document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

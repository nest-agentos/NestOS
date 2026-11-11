import {kanbanPresentation} from '../../ui/app-shell/src/kanban/host';
import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {dismissRecordAttention,withRecordAttention} from '../../libraries/kanban/src/runtime/record-attention';

const projectIds:Record<string,string>={one:'79bdb661-8766-4af8-bb61-10c8d4f2f8cf',two:'1d53a062-dc77-4350-9688-c13962e3506d'};
const ref=(id:string)=>({system:'nestos-remote-project',id:projectIds[id]??id});
const visible=(root:HTMLElement,selector:string)=>{const node=root.querySelector<HTMLElement>(selector),box=node?.getBoundingClientRect();return !!box&&box.width>40&&box.height>10&&box.top>=0&&box.bottom<=innerHeight;};
const wait=async(ready:()=>boolean)=>{for(let i=0;i<1000;i++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('UI_NOT_READY');};
async function run() {
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});
 const journal=new KanbanAutomationJournal(await manager.openFileSystem('/'));await journal.open();
 const service=createKanbanModule({store:await SeqKanbanStore.open(await manager.openFileSystem('/')),actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){}});
 await service.create({id:'board',title:'项目决策验收',scope:{kind:'system'},members:[{kind:'human',id:'owner',responsibility:'Review',roles:['coordinator','reviewer']}]});
 for(let index=0;index<100;index++) {
  const projects=index%4===0?['one','two']:index%2?['one']:['two'];
  await service.execute('board',{operationId:'seed-'+index,expectedRevision:(await service.read('board')).revision,command:{type:'append-record',record:{id:'decision-'+index,kind:'decision',title:'决策 '+index,content:'Requirements '.repeat(128),rationale:'Acceptance',itemIds:[],sources:[],externalRefs:[...projects.map(ref).reverse(),{system:'nestos-primary-project',id:ref(projects[0]).id}]}}});
  await service.execute('board',{operationId:'confirm-'+index,expectedRevision:(await service.read('board')).revision,command:{type:'review-record',recordId:'decision-'+index,accept:true}});
 }
 let serial=0;const command=async(command:any)=>service.execute('board',{operationId:'coord-'+ ++serial,expectedRevision:(await service.read('board')).revision,command});
 await command({type:'create-item',item:{id:'coord',title:'协调任务',purpose:'planning',responsibility:'Plan',acceptance:'Checked',externalRefs:[ref('two')]},planning:{kind:'coordination',priority:2,dependencies:[],references:[]}});
 await command({type:'report-analysis',itemId:'coord',operationId:'failed',status:{itemId:'coord',state:'failed',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED'}});
 await command({type:'link-record',recordId:'decision-98',itemId:'coord'});
 await command({type:'request-record-cancellation',recordId:'decision-96'});await command({type:'cancel-record',recordId:'decision-96'});await command({type:'archive-record',recordId:'decision-96'});
 let sessionBlocked=true;const openedSessions:string[]=[];const discussionAt=Date.now();
 Object.assign(service,{boardSettings:async()=>({fields:['decision','coordination','execution'].map(role=>({name:'harness-'+role,label:role,choices:[{value:'',label:'默认'},{value:'codex',label:'Codex'},{value:'dsh',label:'缺少必要能力',disabled:true}]}))}),openRecordCoordination:async(_board:string,request:any)=>({id:'retained',boardId:'board',recordId:request.recordId,resourceId:'/native/retained',state:'confirmed',createdAt:1}),openTaskCommunication:async()=>({id:'retained',boardId:'board',recordId:'decision-98',resourceId:'/native/retained',state:'confirmed',createdAt:1}),recordConversations:async()=>[
  {id:'linked-discussion',recordId:'decision-98',boardId:'board',state:sessionBlocked?'blocked':'confirmed',createdAt:1,resourceId:'/native/decision-98',sessionId:'original',code:sessionBlocked?'DECISION_SESSION_ERROR_REPORTED':undefined,pendingReports:sessionBlocked?[{id:'error',type:'error'}]:[]},
  {id:'no-session',boardId:'board',state:'error',createdAt:1,code:'ECONFLICT'},
  {id:'draft',boardId:'board',state:'draft',createdAt:discussionAt+2,resourceId:'/native/draft',sessionId:'draft',title:'待确认草稿',resources:[ref('two')]},
  {id:'cancelled-draft',boardId:'board',state:'cancelled',createdAt:discussionAt+4,resourceId:'/native/cancelled',sessionId:'cancelled',title:'已取消的草稿',resources:[ref('two')]},
  {id:'session-error',boardId:'board',state:'error',createdAt:discussionAt+3,resourceId:'/native/failed',sessionId:'failed',title:'接续失败的草稿',code:'EIO',resources:[ref('two')]}],
 recordExecutions:async(_board:string,id:string)=>id==='decision-98'?[{id:'run-0',recordId:id,recordRevision:1,boardId:'board',itemIds:['coord'],stage:'planning',state:'blocked',code:'GIT_RELATIVE_WORKTREES_UNSUPPORTED',createdAt:1,updatedAt:2}]:[],recordResources:async()=>['one','two'].map(id=>({reference:ref(id),label:id==='one'?'项目 A':'项目 B',group:'same-cell'})),startRecordConversation:async()=>{throw Error('UNEXPECTED_CREATION');}});
 let calls:string[]=[];
 const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?async(...args:unknown[])=>{calls.push(String(key));const result=await value.apply(target,args);if(key!=='records')return result;return withRecordAttention({...result,items:result.items.map((record:any)=>record.id==='decision-94'?{...record,progress:{state:'completed',completion:'waived',phase:'completed',lastActivityAt:record.updatedAt,groupIds:['coord'],boardId:'board',itemId:'coord',followUps:[{state:'pending',phase:'cleanup',boardId:'board',itemId:'coord'}]}}:record)},String(args[0]),journal);}:value;}});
 Object.assign(service,{controlRecord:(board:string,request:any):Promise<void>=>dismissRecordAttention(client,journal,board,request)});
 const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board/@decision',selected(){},openSession:async id=>{openedSessions.push(id);},presentation:{...kanbanPresentation,text:key=>(zhCN as Record<string,string>)['kanban.'+key]??key,icons:{close:'×',more:'…',refreshView:'↻'}}});
 const metrics:Array<{operation:string;durationMs:number;logicalApiCalls:number;httpRequests:number;methods:string[]}>=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{calls=[];const started=performance.now();try{await action();await wait(ready);}catch(error){throw Error(operation+':'+(error instanceof Error?error.message:'UNKNOWN'));}const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-decision-list',()=>view.start(),()=>visible(editor,'[data-record-resource]'));
 if(editor.querySelector('[data-context]')?.getAttribute('data-context')!=='decision')throw Error('DECISION_TAB_NOT_FIRST');
 await measure('warm.filter-secondary-project',()=>{const select=editor.querySelector<HTMLSelectElement>('[data-record-resource]')!;select.value=JSON.stringify(ref('two'));select.dispatchEvent(new Event('change',{bubbles:true}));},()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[data-record-resource]')&&view.getActiveResourceId().endsWith('/nestos-remote-project/'+projectIds.two));
 const rows=[...editor.querySelectorAll<HTMLTableRowElement>('[data-decision-row]')],records=[...editor.querySelectorAll<HTMLElement>('[data-record]')];
 const activity=rows.map(row=>Date.parse(row.querySelector('td:nth-child(7) time')!.getAttribute('datetime')!));
 if(activity.some((time,index)=>index>0&&time>activity[index-1])||editor.querySelector('th:nth-child(7)')?.getAttribute('aria-sort')!=='descending')throw Error('DEFAULT_DECISION_ORDER_MISMATCH');
 const projectBox=editor.querySelector('[data-record-resource]')!.getBoundingClientRect(),attentionBox=editor.querySelector('[data-action=decision-attention-filter]')!.getBoundingClientRect();
 if(Math.abs(projectBox.top+projectBox.height/2-attentionBox.top-attentionBox.height/2)>20)throw Error('DECISION_FILTERS_NOT_ON_SAME_ROW');
 await measure('warm.sort-created-desc',()=>editor.querySelector<HTMLButtonElement>('[data-sort=created-desc]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector('th:nth-child(6)')?.getAttribute('aria-sort')==='descending');
 await measure('warm.sort-created-asc',()=>editor.querySelector<HTMLButtonElement>('[data-sort=created-asc]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector('th:nth-child(6)')?.getAttribute('aria-sort')==='ascending');
 await measure('warm.restore-activity-sort',()=>editor.querySelector<HTMLButtonElement>('[data-sort=activity-desc]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector('th:nth-child(7)')?.getAttribute('aria-sort')==='descending');
 await measure('warm.sort-attention-first',()=>editor.querySelector<HTMLButtonElement>('[data-sort=attention]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector('th:nth-child(3)')?.getAttribute('aria-sort')==='other');
 const attention=Number(editor.querySelector('[data-context-count=decision]')!.textContent);
 if(attention<1||editor.querySelectorAll('[data-decision-attention]').length!==attention)throw Error('ATTENTION_ROWS_NOT_MARKED');
 for(const context of ['board','log']){
  await measure('warm.switch-to-'+context,()=>editor.querySelector<HTMLButtonElement>('[data-context='+context+']')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector('[data-context='+context+']')?.getAttribute('aria-current')==='page');
  const badge=editor.querySelector<HTMLElement>('[data-context-count=decision]')!;if(badge.hidden||Number(badge.textContent)!==attention)throw Error('DECISION_ATTENTION_DISAPPEARED');
 }
 await measure('warm.open-attention-decisions',()=>editor.querySelector<HTMLElement>('[data-context-count=decision]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===attention);
 await measure('warm.restore-all-decisions',()=>editor.querySelector<HTMLButtonElement>('[data-action=decision-attention-filter]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===50);
 if(rows.length!==50||records.some(row=>Number(row.dataset.record!.slice('decision-'.length))%2!==0))throw Error('FILTER_RESULT_MISMATCH');
 const ownership=editor.querySelector('[data-record=decision-92]')!.closest('tr')!.querySelector('td:nth-child(2)')!;
 if(ownership.textContent!=='项目 A、项目 B'||ownership.textContent.includes(projectIds.one)||ownership.textContent.includes('主项目'))throw Error('PROJECT_NAME_ORDER_MISMATCH');
 if(editor.querySelector('[data-action=toggle-record-archive]'))throw Error('ARCHIVE_TABLE_STATE_MISMATCH');
 if(!editor.querySelector('[data-decision-row=conversation][data-decision-state=needs-action]')||!editor.querySelector('[data-decision-row=conversation][data-decision-state=failed]')||!editor.querySelector('[data-decision-row=conversation][data-decision-state=cancelled]'))throw Error('DRAFT_TABLE_STATE_MISMATCH');
 if(!editor.querySelector('[data-record=decision-98]')!.closest('tr')!.querySelector('td:nth-child(5)')!.textContent?.includes('DECISION_SESSION_ERROR_REPORTED'))throw Error('SESSION_ERROR_STATE_MISSING');
 await measure('warm.resolve-decision-session',()=>{sessionBlocked=false;editor.querySelector<HTMLButtonElement>('[data-titlebar-action][data-action=refresh]')!.click();},()=>!editor.hasAttribute('aria-busy')&&!editor.querySelector('[data-record=decision-98]')!.closest('tr')!.querySelector('td:nth-child(5)')!.textContent?.includes('DECISION_SESSION_ERROR_REPORTED'));
 const finished=editor.querySelector('[data-record=decision-94]')!.closest('tr')!;
 if(!finished.querySelector('[data-record]')?.textContent?.startsWith('KBD-1-95 · '))throw Error('DECISION_REFERENCE_ORDER_MISMATCH');
 if(finished.dataset.decisionState!=='completed'||!finished.querySelector('[data-decision-completion]')?.textContent?.includes('有豁免')||!finished.querySelector('[data-decision-follow-up]')?.textContent?.includes('清理'))throw Error('COMPLETED_GROUP_FOLLOW_UP_MISMATCH');
 await measure('warm.open-follow-up-task',()=>finished.querySelector<HTMLButtonElement>('[data-action=open-decision-task]')!.click(),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-panel] .kanban__item-overview'));
 if(editor.querySelector('[data-panel] .kanban__resource-summary')?.textContent!=='项目 B')throw Error('TASK_PROJECT_NAME_MISSING');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.return-to-decision-list',()=>view.openResource('/board/board/@decision/nestos-remote-project/'+projectIds.two),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('.kanban__decision-table'));
 await measure('warm.enter-failed-task-session',()=>editor.querySelector<HTMLButtonElement>('[data-action=open-task-communication][data-communication-item=coord]')!.click(),()=>!editor.hasAttribute('aria-busy')&&openedSessions.length===1);
 await measure('warm.enter-persistent-coordination',()=>editor.querySelector<HTMLButtonElement>('[data-action=open-record-coordination][data-coordination-record=decision-98]')!.click(),()=>!editor.hasAttribute('aria-busy')&&openedSessions.length===2);
 if(openedSessions.some(id=>id!=='/native/retained'))throw Error('WRONG_COMMUNICATION_SESSION');
 const scroll=editor.querySelector<HTMLElement>('.kanban__decision-scroll')!,box=scroll.getBoundingClientRect();
 if(box.height<180||box.bottom>innerHeight||scroll.scrollHeight<=scroll.clientHeight)throw Error('TABLE_SCROLL_UNUSABLE');
 scroll.scrollTop=scroll.scrollHeight;if(scroll.scrollTop<100)throw Error('TABLE_NOT_SCROLLABLE');scroll.scrollTop=0;
 await measure('warm.next-combined-page',()=>editor.querySelector<HTMLButtonElement>('[data-action=records-next]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===3);
 const archived=editor.querySelector('[data-decision-archived]')!.closest('tr')!;if(archived.dataset.decisionState!=='cancelled'||!archived.querySelector('td:nth-child(7)')?.textContent?.includes('归档于'))throw Error('ARCHIVED_OUTCOME_MISSING');
 await measure('warm.first-combined-page',()=>editor.querySelector<HTMLButtonElement>('[data-action=records-first]')!.click(),()=>!editor.hasAttribute('aria-busy')&&editor.querySelectorAll('[data-decision-row]').length===50);
 await measure('warm.open-failed-decision',()=>editor.querySelector<HTMLButtonElement>('[data-record=decision-98]')!.click(),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-decision-failures]'));
 const failures=editor.querySelector('[data-decision-failures]')!;
 if(!failures.textContent?.includes('决策 98')||!failures.textContent.includes('GIT_RELATIVE_WORKTREES_UNSUPPORTED')||!failures.querySelector('[data-item=coord]'))throw Error('DECISION_FAILURE_CONTEXT_MISSING');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.open-new-decision-dialog',()=>editor.querySelector<HTMLButtonElement>('[data-action=new-decision]')!.click(),()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[name=primaryResource]')&&!editor.querySelector<HTMLButtonElement>('[data-form=decision-conversation] button:not([type])')?.disabled);
 if(editor.querySelector<HTMLSelectElement>('[name=primaryResource]')!.value!==JSON.stringify(ref('two')))throw Error('PRIMARY_PREFILL_MISMATCH');
 const secondary=[...editor.querySelectorAll<HTMLInputElement>('[name=decisionResource]')];
 const self=secondary.find(input=>input.value===JSON.stringify(ref('two')))!,other=secondary.find(input=>input.value===JSON.stringify(ref('one')))!;
 if(getComputedStyle(self.closest('label')!).display!=='none'||other.disabled)throw Error('SECONDARY_PROJECT_CHOICES_INVALID');
 other.click();if(!other.checked)throw Error('SECONDARY_PROJECT_NOT_SELECTABLE');
 const primary=editor.querySelector<HTMLSelectElement>('[name=primaryResource]')!;primary.value=JSON.stringify(ref('one'));primary.dispatchEvent(new Event('change',{bubbles:true}));
 if(other.checked||getComputedStyle(other.closest('label')!).display!=='none'||self.disabled)throw Error('SECONDARY_PROJECT_SWITCH_INVALID');
 self.click();if(!self.checked)throw Error('PREVIOUS_PRIMARY_NOT_SELECTABLE');
 if((await service.records('board',{includeArchived:true})).total!==100)throw Error('BROWSE_MUTATED_DECISIONS');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.open-board-settings',()=>{const button=editor.querySelector<HTMLButtonElement>('[data-action=board-settings]')!;button.closest('details')?.setAttribute('open','');button.click();},()=>!editor.hasAttribute('aria-busy')&&visible(editor,'[name=setting-harness-decision]'));
 if(editor.querySelectorAll('[data-form=board-settings] select').length!==3)throw Error('SETTINGS_FIELDS_MISSING');
 const selected=editor.querySelector<HTMLSelectElement>('[name=setting-harness-execution]')!;if(!selected.querySelector<HTMLOptionElement>('[value=dsh]')!.disabled)throw Error('UNSUPPORTED_HARNESS_ENABLED');selected.value='codex';
 await measure('warm.save-board-settings',()=>editor.querySelector<HTMLFormElement>('[data-form=board-settings]')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})),()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 if((await service.read('board')).settings?.['harness-execution']!=='codex')throw Error('SETTINGS_SAVE_MISSING');
 await measure('warm.reopen-board-settings',()=>{const button=editor.querySelector<HTMLButtonElement>('[data-action=board-settings]')!;button.closest('details')?.setAttribute('open','');button.click();},()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLSelectElement>('[name=setting-harness-execution]')?.value==='codex');
 editor.querySelector<HTMLButtonElement>('[data-action=close-panel]')!.click();await wait(()=>!editor.hasAttribute('aria-busy')&&editor.querySelector<HTMLElement>('[data-panel]')!.hidden);
 await measure('warm.open-board-catalog',()=>view.openResource('/'),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-board=board]'));
 await measure('warm.board-defaults-to-decisions',()=>editor.querySelector<HTMLButtonElement>('[data-board=board]')!.click(),()=>!editor.hasAttribute('aria-busy')&&view.getActiveResourceId()==='/board/board/@decision'&&!!editor.querySelector('.kanban__decision-table'));
 const beforeDismiss=Number(editor.querySelector('[data-context-count=decision]')!.textContent);
 await measure('warm.dismiss-current-attention',()=>editor.querySelector<HTMLButtonElement>('[data-attention-record=decision-98]')!.click(),()=>!editor.hasAttribute('aria-busy')&&!editor.querySelector('[data-attention-record=decision-98]'));
 if(Number(editor.querySelector('[data-context-count=decision]')!.textContent)!==beforeDismiss-1)throw Error('ATTENTION_COUNT_NOT_DISMISSED');
 if(editor.querySelector('[data-record=decision-98]')?.closest('tr')?.getAttribute('data-decision-state')!=='failed')throw Error('DISMISSAL_CHANGED_EXECUTION_STATE');
 await measure('warm.reopen-dismissed-attention',()=>view.openResource('/board/board/@decision'),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-record=decision-98]'));
 if(editor.querySelector('[data-attention-record=decision-98]'))throw Error('DISMISSAL_NOT_PERSISTED');
 await command({type:'report-analysis',itemId:'coord',operationId:'failed',status:{itemId:'coord',state:'failed',code:'NEW_ATTENTION_ERROR'}});
 await measure('warm.observe-new-attention',()=>view.openResource('/board/board/@decision'),()=>!editor.hasAttribute('aria-busy')&&!!editor.querySelector('[data-attention-record=decision-98]'));
 const result={result:'passed',environment:'Google Chrome headless; actual DOM and MemoryBackend/SeqKanbanStore; in-process KanbanClient; no HTTP transport',dataset:{boards:1,decisions:100,archivedDecisions:1,projects:2,relatedDecisions:50,coordinationTasks:1,draftSessions:3,cancelledDrafts:1,hiddenSessionlessFailures:1,backgroundLoad:'none',completionWithWaiverAndPendingCleanup:1},metrics};

 document.body.dataset.acceptance='passed';document.getElementById('result')!.textContent=JSON.stringify(result);(globalThis as any).__kanbanAcceptance=result;
 // Keep the unified table visible for the screenshot; the browser process owns its lifetime.
}
void run().catch(error=>{document.body.dataset.acceptance='failed';document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

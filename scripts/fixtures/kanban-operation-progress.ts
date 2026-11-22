import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {jobKey,KanbanAutomationJournal,reviewCleanupKey,reviewKey} from '@nestos/kanban/integration';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import {createItemOperations} from '../../backend/kanban-development/src/index';
const wait=async(ready:()=>boolean)=>{for(let n=0;n<1000;n++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('WAIVER_UI_NOT_READY');};
async function run(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},verifyOutputs:async()=>true,log(){}}),worker=createKanbanModule({store,actor:{kind:'service',id:'worker'},authorize:async()=>{},log(){}});
 await service.create({id:'board',title:'验收豁免验收',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'reviewer',responsibility:'Review',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Work',roles:['worker']}]});
 let seq=0;const command=async(command:any,api=service)=>api.execute('board',{operationId:'seed-'+ ++seq,expectedRevision:(await api.read('board')).revision,command});
 await command({type:'create-item',item:{id:'management',taskType:'coordination',title:'交付测试',responsibility:'Coordinate',acceptance:'Use the original receipt'}});
 await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',rootItemId:'management',revision:1,sealed:true,items:[{id:'task',title:'带依赖的验收与合并',responsibility:'Work',acceptance:'Acceptance',assignee:{kind:'service',id:'worker'},dependsOn:[]}]}});
 await command({type:'prepare-dispatch',itemId:'task',dispatchId:'execution'},worker);await command({type:'observe-execution',dispatchId:'execution',fence:(await service.workflow('board')).dispatches.execution.fence,outcome:'succeeded'});
 const journal=new KanbanAutomationJournal(fs);await journal.open();let starts=0,switches=0,cleanups=0,runningVersion='old-release',release!:()=>void;
 const preparation=new Promise<void>(resolve=>{release=resolve;});
 const operations=createItemOperations({service,journal,catalog:async()=>({entries:[]}),cleanup:async()=>{cleanups++;return true;},adapter:{supports:()=>true,runningVersion:()=>runningVersion,
    managed:{prepare:async({id}:any)=>({operationId:id,serviceId:'test-host',expectedVersion:'old-release',targetVersion:'candidate'}),
        submit:async()=>{switches++;},inspect:async(job:any)=>({state:'succeeded',output:{schema:'nestos.kanban.operation-result/1',operationId:job.id,sourceVersion:'s',targetVersion:'t',status:'succeeded',version:'candidate'}})},
    snapshot:async()=>({version:'v',sourceVersion:'s',targetVersion:'t',context:{}}),prepareOperation:async({id}:any)=>{await preparation;return {expectedSessionId:'build-session',expectedBranch:'main',submission:{id,source:{kind:'conversation',ownerId:'build-session',id}}};}},submission:{start:async()=>{starts++;},inspect:async()=>({sessionId:'build-session',outcome:'running'})},published:{start:async()=>{throw Error('UNEXPECTED_FLOW');}},sessionResource:async()=>'/native/build-session',log(){}} as never);
 Object.assign(service,{itemOperations:operations.itemOperations,runItemOperation:operations.runItemOperation,bindItemOperation:operations.bindItemOperation,
    workResources:async(_board:string,_item:string,request:{inspect:boolean})=>cleanups?[{id:'source',title:'执行工作树',location:'/workspace/source',state:'cleaned',version:'v2',reasons:[],properties:[],canCleanup:false}]:request.inspect?[{id:'source',title:'执行工作树',location:'/workspace/source',state:'retained',version:'v1',
        reasons:['WORKTREE_NOT_INTEGRATED'],properties:[{label:'未合入的子仓库',value:'libraries/example'}],canCleanup:false}]:[]});
 let calls:string[]=[];const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board/task',itemOperationsAvailable:()=>true,selected(){},openSession:async()=>{},presentation:{text:key=>(zhCN as Record<string,string>)['kanban.'+key]??key,icons:{more:'…',close:'×',refreshView:'↻'}}});
 const metrics:any[]=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{calls=[];const started=performance.now();await action();try{await wait(ready);}catch(error){throw Error(operation+': '+(error as Error).message+' · '+[...editor.querySelectorAll('[role=alert],[data-operation-submit-status]')].map(node=>node.textContent).join(' | ')+' · '+calls.join(',')+' · '+switches);}const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-operation-feedback',()=>view.start(),()=>!!editor.querySelector('[data-form="item-operation"][data-operation="build"]'));
 const form=editor.querySelector<HTMLFormElement>('[data-form="item-operation"][data-operation="build"]')!,button=form.querySelector<HTMLButtonElement>('button')!;
 await measure('warm.click-pending-build',()=>button.click(),()=>!!form.querySelector('[data-operation-submit-status]'));
 if(editor.querySelectorAll('[data-operation-group]').length!==4)throw Error('FOUR_STAGES_MISSING');
 if(!button.disabled||starts)throw Error('SUBMISSION_FEEDBACK_INVALID');button.click();if(calls.filter(id=>id==='runItemOperation').length!==1)throw Error('DUPLICATE_SUBMISSION');
 await measure('warm.receive-build-admission',()=>release(),()=>!!editor.querySelector('[data-operation-progress="running"]'));
 if(starts!==1||!editor.textContent!.includes('执行已启动'))throw Error('MISSING_RUNNING_FEEDBACK');
 const row=(await operations.itemOperations('board','task')).operations.find(row=>row.id==='build')!;
 await journal.update<any>('review-operation:'+row.runId,old=>({...old,state:'unknown',code:'TRANSPORT_DISCONNECTED'}));
 await measure('warm.refresh-uncertain-build',()=>editor.querySelector<HTMLButtonElement>('[data-action="refresh-item-operations"]')!.click(),()=>!!editor.querySelector('[data-operation-progress="reconciling"]'));
 if(starts!==1||(await service.item('board','task')).item.status!=='review')throw Error('EXECUTION_REPLAYED_OR_COMPLETED');
 await journal.update<any>('review-operation:'+row.runId,old=>({...old,phase:'settled',state:'succeeded',code:undefined,result:{schema:'nestos.kanban.operation-result/1',operationId:row.runId,sourceVersion:'s',targetVersion:'t',status:'succeeded',version:'candidate'}}));
 const refresh=()=>editor.querySelector<HTMLButtonElement>('[data-action="refresh-item-operations"]')!.click();
 const deploy=()=>editor.querySelector<HTMLFormElement>('[data-form="item-operation"][data-operation="deploy"]');
 await measure('warm.open-replacement',refresh,()=>!!deploy()?.querySelector('button:not(:disabled)'));
 const confirmation=deploy()!.querySelector<HTMLInputElement>('[name="confirmed"]')!;
 confirmation.checked=true;
 await measure('warm.show-version-mismatch',()=>deploy()!.requestSubmit(),()=>!!editor.querySelector('[data-form="item-operation-reconcile"][data-operation="deploy"]'));
 if(switches!==1||!editor.textContent!.includes('验收版本为 candidate')||!editor.textContent!.includes('old-release'))throw Error('REPLACEMENT_DIAGNOSTIC_MISSING');
 runningVersion='candidate';
 const check=()=>editor.querySelector<HTMLButtonElement>('[data-form="item-operation-reconcile"][data-operation="deploy"] button')!.click();
 await measure('warm.verify-original-switch',check,()=>!editor.querySelector('[data-form="item-operation-reconcile"]')&&!!editor.querySelector('[data-form="item-operation"][data-operation="accept"] button:not(:disabled)'));
 if(switches!==1||(await operations.itemOperations('board','task')).operations.find(op=>op.id==='deploy')?.state!=='succeeded')throw Error('SWITCH_REPLAYED_OR_UNVERIFIED');
 await journal.update(jobKey('original-submit'),()=>({id:'original-submit',boardId:'board',itemId:'task',action:'merge',phase:'settled',state:'succeeded'}));
 await journal.update<any>(reviewKey('board','task'),old=>({...old,jobs:[...old.jobs,'original-submit']}));
 await journal.update(reviewCleanupKey('board','task'),()=>({runId:'original-submit',operationId:'original-cleanup',attempt:0,state:'failed',code:'WORKTREE_NOT_INTEGRATED',retryFresh:true}));
 const inspect=()=>editor.querySelector<HTMLButtonElement>('[data-operation-id=merge] [data-reveal-resources]');
 await measure('warm.show-cleanup-blocker',refresh,()=>!!inspect());
 const cleanup=editor.querySelector<HTMLFormElement>('[data-operation=cleanup]')!;
 if(cleanup.querySelector('strong')?.textContent!=='清理工作树'||cleanup.querySelector('button')?.textContent!=='重试清理')throw Error('CLEANUP_ACTION_MISLABELED');
 await measure('warm.inspect-cleanup-conditions',()=>inspect()!.click(),()=>!!editor.querySelector('[data-work-resources][open] [data-work-resource=source]'));
 if(!editor.querySelector('[data-work-resource=source] [data-action=ignore-work-resource]')||!editor.textContent!.includes('libraries/example')||cleanups)throw Error('CLEANUP_DIAGNOSTIC_MISSING');
 await measure('warm.retry-cleanup-only',()=>cleanup.querySelector<HTMLButtonElement>('button')!.click(),()=>!inspect()&&cleanups===1
    &&!!editor.querySelector('[data-work-resource=source]')?.textContent?.includes('已清理'));
 if(starts!==1||switches!==1)throw Error('UNRELATED_OPERATION_REPLAYED');
 document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual Kanban domain, SeqFile store, review service and DOM; no HTTP transport',dataset:{boards:1,tasks:1,operations:5,backgroundLoad:'none',buildSubmission:'suspended then admitted then unknown'},metrics});
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

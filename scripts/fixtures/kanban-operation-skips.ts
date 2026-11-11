import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import {createItemOperations} from '../../backend/app-core/src/kanban/item-operations';
const wait=async(ready:()=>boolean)=>{for(let n=0;n<1000;n++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('WAIVER_UI_NOT_READY');};
async function run(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'reviewer'},authorize:async()=>{},verifyOutputs:async()=>true,log(){}}),worker=createKanbanModule({store,actor:{kind:'service',id:'worker'},authorize:async()=>{},log(){}});
 await service.create({id:'board',title:'验收豁免验收',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'reviewer',responsibility:'Review',roles:['coordinator','reviewer']},{kind:'service',id:'worker',responsibility:'Work',roles:['worker']}]});
 let seq=0;const command=async(command:any,api=service)=>api.execute('board',{operationId:'seed-'+ ++seq,expectedRevision:(await api.read('board')).revision,command});
 await command({type:'publish-plan',plan:{schema:'kanban.plan/1',id:'plan',revision:1,sealed:true,items:[{id:'task',title:'跳过验收后继续提交',responsibility:'Work',acceptance:'Acceptance',assignee:{kind:'service',id:'worker'},dependsOn:[]}]}});
 await command({type:'prepare-dispatch',itemId:'task',dispatchId:'execution'},worker);await command({type:'observe-execution',dispatchId:'execution',fence:(await service.workflow('board')).dispatches.execution.fence,outcome:'succeeded'});
 const journal=new KanbanAutomationJournal(fs);await journal.open();let starts=0,cleanups=0,settled=false;
 const snapshot={version:'v',sourceVersion:'s',targetVersion:'t',context:{}};
 for(const [index,action] of ['build','deploy'].entries())await journal.update('review-operation:seed-'+action,()=>({id:'seed-'+action,boardId:'board',itemId:'task',action,phase:'settled',state:'succeeded',fingerprint:'seed',snapshot,result:{sourceVersion:'s',targetVersion:'t',version:'v'},createdAt:index+1}));
 await journal.update('review-operations:'+JSON.stringify(['board','task']),()=>({revision:1,bindings:{},jobs:['seed-build','seed-deploy'],receipts:{}}));
 const unsupported=async()=>{throw Error('UNEXPECTED_EXECUTION');};
 const operations=createItemOperations({service,journal,catalog:async()=>({entries:[]}),adapter:{supports:()=>true,snapshot:async()=>snapshot,
  prepareOperation:async({id}:any)=>({expectedSessionId:'original',submission:{id}}),readOperation:async(job:any)=>job.action==='analyze'?{sourceVersion:'s',targetVersion:'t',summary:'Checked merge plan',conflicts:[]}:{schema:'nestos.kanban.operation-result/1',operationId:job.id,sourceVersion:'s',targetVersion:'t',status:'succeeded'}},
  submission:{start:async()=>{starts++;return {sessionId:'original',outcome:'running'};},inspect:async()=>({sessionId:'original',outcome:settled?'succeeded':'running'})},published:{start:unsupported,inspect:unsupported},cleanup:async()=>{cleanups++;return true;},log(){}} as never);
 Object.assign(service,{itemOperations:operations.itemOperations,runItemOperation:operations.runItemOperation,bindItemOperation:operations.bindItemOperation});
 let calls:string[]=[];const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board/task',itemOperationsAvailable:()=>true,selected(){},openSession:async()=>{},presentation:{text:key=>(zhCN as Record<string,string>)['kanban.'+key]??key,icons:{more:'…',close:'×',refreshView:'↻'}}});
 const metrics:any[]=[];
 const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{calls=[];const started=performance.now();await action();await wait(ready);const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-review-actions',()=>view.start(),()=>!!editor.querySelector('[data-current-operation] [data-operation=accept]'));
 const skip=editor.querySelector<HTMLFormElement>('[data-form=item-operation-skip][data-operation=accept]')!;
 if(JSON.stringify(JSON.parse(skip.dataset.affected!))!=='["accept"]')throw Error('SUBMISSION_WRONGLY_WAIVED');
 for(const details of editor.querySelectorAll<HTMLDetailsElement>('[data-item-operations] details'))details.open=true;
 skip.querySelector<HTMLTextAreaElement>('textarea')!.value='本次验收豁免，提交仍需完成';skip.querySelector<HTMLInputElement>('[name=confirmed]')!.checked=true;
 await measure('warm.skip-acceptance-only',()=>skip.requestSubmit(),()=>!!editor.querySelector('[data-current-operation] [data-operation=analyze]'));
 if((await service.item('board','task')).item.status!=='review'||cleanups)throw Error('PREMATURE_COMPLETION');
 const execute=async(action:string)=>{settled=false;const before=starts,form=editor.querySelector<HTMLFormElement>('[data-form=item-operation][data-operation='+action+']')!;
  const confirmation=form.querySelector<HTMLInputElement>('[name=confirmed]');if(confirmation){if(form.checkValidity())throw Error('CONFIRMATION_MISSING');confirmation.checked=true;}
  form.requestSubmit();await wait(()=>starts>before);await wait(()=>!editor.querySelector('[data-operation-submit-status]'));settled=true;await operations.scan();await (view as any).refresh();};
 await measure('warm.analyze-after-waiver',()=>execute('analyze'),()=>!!editor.querySelector('[data-current-operation] [data-operation=merge]'));
 if(cleanups||starts!==1)throw Error('CLEANED_BEFORE_MERGE');
 await measure('warm.merge-after-waiver',()=>execute('merge'),()=>!!editor.querySelector('[data-task-phase=completed]'));
 const item=(await service.item('board','task')).item;
 if(item.acceptanceResult?.outcome!=='waived'||item.operationWaivers?.length!==1||item.operationWaivers[0].operations.map(row=>row.id).join(',')!=='accept'||starts!==2||cleanups!==1)throw Error('WAIVER_AUDIT_INVALID');
 document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual Kanban domain, SeqFile store, review service and DOM; simulated executor; no HTTP transport',dataset:{boards:1,tasks:1,operations:5,waivers:1,backgroundLoad:'none'},metrics});
 await operations.quiesce();await view.destroy();await manager.dispose();
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

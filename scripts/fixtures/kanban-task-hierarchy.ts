import {zhCN} from '../../shared/common/src/i18n/zh-CN';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {SeqKanbanStore} from '@nestos/kanban';
import {createKanbanActivityModule} from '@nestos/kanban/activity';
import {KanbanWorkbench} from '@nestos/kanban-ui';
import type {KanbanClient,KanbanCommand} from '@nestos/kanban/contracts';

async function wait(ready:()=>boolean){
    for(let attempt=0;attempt<800;attempt++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}
    throw Error('UI_NOT_READY');
}
async function run(){
    const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/');
    const service:KanbanClient=createKanbanActivityModule({store:await SeqKanbanStore.open(fs),actor:{kind:'human',id:'owner'},authorize:async()=>{},log(){},referenceSystem:'external-job',executionSessions:{source:{
        authorizeBinding:async()=>{},inspect:async(_board,id)=>({sessionId:id,resourceId:'/native/'+id,state:'waiting-input',stale:false,observedAt:Date.now(),lastActivityAt:Date.now()})}}});
    await service.create({id:'board',title:'交付看板',scope:{kind:'system'},policy:{requireEstimate:false},members:[{kind:'human',id:'owner',responsibility:'Manage',roles:['coordinator','reviewer','worker']}]});
    let seq=0;const command=async(command:KanbanCommand)=>service.execute('board',{operationId:'seed-'+ ++seq,expectedRevision:(await service.read('board')).revision,command});
    for(let group=0;group<3;group++){
        await command({type:'create-item',item:{id:'manager-'+group,title:['知识库导入','搜索体验改进','发布准备'][group],responsibility:'落实目标并核对整体交付结果',acceptance:'所有必要执行任务通过验收',purpose:'planning'},planning:{kind:'coordination',execution:'children',priority:group,dependencies:[],references:[]}});
        for(let child=0;child<8;child++)await command({type:'create-item',item:{id:`task-${group}-${child}`,title:child===7?'确认导入时的覆盖范围':'执行任务 '+(child+1),responsibility:'落实具体工作',acceptance:'验证产物'},planning:{kind:'task',parentId:'manager-'+group,priority:2,dependencies:[],references:[]}});
        await command({type:'report-analysis',itemId:`task-${group}-7`,operationId:'clarify-'+group,status:{itemId:`task-${group}-7`,state:'clarification',reason:'需要确认目标版本和覆盖范围'}});
        await command({type:'link-reference',itemId:`task-${group}-7`,reference:{system:'external-job',id:`original-${group}`,revision:'binding-'+group}});
    }
    service.planningSession=async(_board,itemId)=>({itemId,analysisId:'plan-'+itemId,sessionId:'internal-'+itemId,resourceId:'/native/'+itemId,state:'waiting-input',stale:false,recent:true});
    service.itemOperations=async(_board,itemId)=>({revision:'handoff',operations:[],...(itemId.startsWith('task-')?{owner:{boardId:'board',itemId:'manager-'+itemId.split('-')[1]}}:{})});
    let calls:string[]=[],created=0,opened:string[]=[];
    service.openTaskCoordination=async()=>{created++;throw Error('READ_CREATED_SESSION');};
    const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
    const editor=document.getElementById('editor')!,view=new KanbanWorkbench({service:client,editor,initialResource:'/board/board',selected(){},openSession:async id=>{opened.push(id);},presentation:{text:(key,values)=>{
        let value=(zhCN as Record<string,string>)['kanban.'+key]??key;for(const [name,replacement] of Object.entries(values??{}))value=value.replaceAll('{'+name+'}',String(replacement));return value;
    },icons:{close:'×',more:'…',refreshView:'↻'}}});
    const metrics:any[]=[];
    const measure=async(operation:string,action:()=>Promise<unknown>|void,ready:()=>boolean)=>{
        calls=[];const start=performance.now();await action();await wait(()=>!editor.hasAttribute('aria-busy')&&ready());
        const row={operation,durationMs:Math.round((performance.now()-start)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);
        if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);
    };
    await measure('cold.open-grouped-board',()=>view.start(),()=>editor.querySelectorAll('[data-item-card=manager-0] [data-managed-child]').length===6&&!!editor.querySelector('[data-item-card=manager-0] [data-session="/native/original-0"]'));
    const card=editor.querySelector('[data-item-card=manager-0]')!;
    if(card.closest('[data-column]')?.getAttribute('data-column')!=='claimed')throw Error('MANAGER_COLUMN_MISMATCH');
    if(card.querySelector('[data-managed-child]')?.getAttribute('data-item-card')!=='task-0-7')throw Error('ATTENTION_NOT_FIRST');
    if(editor.querySelectorAll('.kanban__column').length!==7||editor.textContent?.includes('横向查看阶段')||editor.querySelector('[data-action=scroll-left]'))throw Error('LAYOUT_MISMATCH');
    await measure('warm.open-management-task',()=>card.querySelector<HTMLButtonElement>('[data-item=manager-0]')!.click(),()=>!!editor.querySelector('[data-participation=coordination] [data-session="/native/manager-0"]')&&!!editor.querySelector('[data-participation] .kanban__group-attention [data-item=task-0-7]'));
    const participation=editor.querySelector('[data-participation]')!,definition=editor.querySelector('[data-detail-text=responsibility]')!;
    if(!(participation.compareDocumentPosition(definition)&Node.DOCUMENT_POSITION_FOLLOWING)||created)throw Error('PARTICIPATION_ORDER_MISMATCH');
    const sessionRect=participation.querySelector('[data-session]')!.getBoundingClientRect();
    if(sessionRect.bottom>innerHeight||sessionRect.top<0)throw Error('SESSION_BELOW_FOLD');
    await measure('warm.open-original-execution-session',()=>participation.querySelector<HTMLButtonElement>('.kanban__group-attention [data-session]')!.click(),()=>opened[0]==='/native/original-0');
    await measure('warm.open-execution-task',()=>participation.querySelector<HTMLButtonElement>('[data-item=task-0-7]')!.click(),()=>!!editor.querySelector('[data-participation=execution] [data-session="/native/original-0"]'));
    await wait(()=>!!editor.querySelector('[data-participation=execution] [data-progress-item=manager-0]'));
    if(editor.querySelector('[data-participation=execution] [data-form=item-operation]')||editor.querySelector('[data-participation=execution] [data-operation-group=accept]'))throw Error('EXECUTION_HANDOFF_REQUIRES_USER');
    await measure('warm.return-board',()=>view.openResource('/board/board'),()=>!editor.querySelector('[data-participation]')&&!!editor.querySelector('[data-item-card=manager-0] [data-session="/native/original-0"]'));
    // The bounded browser scope owns the visible snapshot and remaining subscriptions.
    view.setVisible(false);
    if(editor.querySelector('[data-error]')?.textContent)throw Error('UNEXPECTED_READ_ERROR');
    document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Google Chrome headless; actual DOM, MemoryBackend/SeqKanbanStore, in-process KanbanClient and injected authorized Session source; no HTTP transport',dataset:{boards:1,managementTasks:3,executionTasks:24,waitingInput:3,sessions:6,backgroundLoad:'none'},metrics});
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

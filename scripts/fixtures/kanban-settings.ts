import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {createKanbanModule,SeqKanbanStore} from '@nestos/kanban';
import {KanbanWindowWorkbench} from '../../ui/app-shell/src/kanban/windows';
import {t} from '../../shared/common/src/i18n';
const wait=async(ready:()=>boolean)=>{for(let n=0;n<1000;n++){if(ready())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('SETTINGS_UI_NOT_READY');};
async function run(){
 const {manager}=await createVFS({rootBackend:new MemoryBackend()}),fs=await manager.openFileSystem('/'),store=await SeqKanbanStore.open(fs);
 const service=createKanbanModule({store,actor:{kind:'human',id:'admin'},authorize:async()=>{},log(){}});
 for(const id of ['development','other'])await service.create({id,title:id,scope:{kind:'system'},members:[{kind:'human',id:'admin',responsibility:'Manage',roles:['coordinator','worker','reviewer']}]});
 Object.assign(service,{boardSettings:async()=>({fields:['decision','coordinator','worker'].map(role=>({name:role,label:role+' harness',choices:[{value:'',label:'Default'},{value:'codex',label:'Codex'},{value:'claude',label:'Claude'}]}))})});
 let calls:string[]=[];const client=new Proxy(service,{get(target,key){const value=Reflect.get(target,key);return typeof value==='function'?(...args:unknown[])=>{calls.push(String(key));return value.apply(target,args);}:value;}});
 const editor=document.getElementById('editor')!,sidebar=document.createElement('aside');document.body.prepend(sidebar);
 const workbench=new KanbanWindowWorkbench({service:client,sidebar,editor,initialResource:'/board/development',selected(){},openSession:async()=>{}});
 const metrics:any[]=[];
 const measure=async(operation:string,action:()=>void|Promise<unknown>,ready:()=>boolean)=>{calls=[];const started=performance.now();await action();try{await wait(ready);}catch{throw Error(operation+':SETTINGS_UI_NOT_READY');}const row={operation,durationMs:Math.round((performance.now()-started)*100)/100,logicalApiCalls:calls.length,httpRequests:0,methods:[...calls]};metrics.push(row);if(row.durationMs>=5000||row.logicalApiCalls>=30)throw Error('PERFORMANCE_LIMIT:'+operation);};
 await measure('cold.open-board',()=>workbench.start(),()=>!!editor.querySelector('[data-action="board-settings"]'));
 await measure('warm.open-menu-settings',()=>editor.querySelector<HTMLButtonElement>('[data-action="board-settings"]')!.click(),()=>!!document.querySelector('[data-board-settings="development"]'));
 const dialog=document.querySelector<HTMLDialogElement>('dialog.kanban-sidebar-controls')!;
 if(!dialog.textContent!.includes(t('kanban.boardControl.execution'))||!dialog.querySelector('[data-board-control="manual"]')||dialog.querySelectorAll('[data-board-settings] select').length!==3)throw Error('INCOMPLETE_SHARED_SETTINGS');
 if(dialog.querySelector<HTMLSelectElement>('[data-settings-scope]')!.value!=='development')throw Error('WRONG_BOARD_SCOPE');
 dialog.querySelector<HTMLSelectElement>('[name="setting-worker"]')!.value='codex';
 await measure('warm.save-harness',()=>dialog.querySelector<HTMLFormElement>('form')!.requestSubmit(),()=>!document.querySelector('dialog.kanban-sidebar-controls'));
 if((await service.read('development')).settings?.worker!=='codex'||(await service.read('other')).settings)throw Error('SETTINGS_SCOPE_CHANGED');
 await measure('warm.open-sidebar-settings',()=>sidebar.querySelector<HTMLButtonElement>('[data-action="execution-settings"]')!.click(),()=>!!document.querySelector('[data-board-settings="development"]'));
 if(document.querySelector<HTMLSelectElement>('[name="setting-worker"]')!.value!=='codex'||document.querySelectorAll('dialog.kanban-sidebar-controls').length!==1)throw Error('SETTINGS_ENTRANCES_DIFFER');
 document.getElementById('result')!.textContent=JSON.stringify({result:'passed',environment:'Chrome headless; actual Kanban host, shared settings dialog, domain and SeqFile store; no HTTP transport',dataset:{boards:2,harnessFields:3,backgroundLoad:'none'},metrics});
}
void run().catch(error=>{document.getElementById('result')!.textContent=JSON.stringify({result:'failed',code:error instanceof Error?error.message:'UNKNOWN'});});

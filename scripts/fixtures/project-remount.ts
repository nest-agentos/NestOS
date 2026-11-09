import {projectRemountFields} from '../../ui/app-shell/src/projects/project-remount-fields';
import {CellsProjectClient} from '../../libraries/cells-driver/src/projects';
import {createCellsRpc} from '../../libraries/cells-driver/src/harness/rpc';
import type {ProjectRemoteMountPort,ProjectRemoteMount} from '@nestos/app-contracts/services';
const fixture=(globalThis as unknown as {fixture:{endpoint:string;projectId:string}}).fixture;
let apiCalls=0,httpRequests=0;
const authorizedFetch:typeof fetch=(input,init)=>{
 const headers=new Headers(init?.headers);headers.set('Authorization','Bearer local-remount-fixture-0123456789');
 httpRequests++;if(String(input).includes('/v1/api/'))apiCalls++;
 return fetch(input,{...init,headers});
};
const client=new CellsProjectClient(createCellsRpc(fixture.endpoint,authorizedFetch));
function assert(value:unknown,message:string):asserts value {if(!value)throw Error(message);}
async function main(){
 const baseline={api:apiCalls,http:httpRequests},started=performance.now();
 const remote={projectRemountOptions:async()=>{
  const [binding,available]=await Promise.all([client.binding(fixture.projectId),client.roots()]);
  return {...binding,roots:available.roots};
 }} as unknown as ProjectRemoteMountPort;
 const root={alias:'old',root:'/',access:'rw'} as ProjectRemoteMount;
 const opening=new Promise<Awaited<ReturnType<typeof projectRemountFields>>>((resolve,reject)=>{
  document.querySelector<HTMLButtonElement>('#open')!.onclick=()=>{void projectRemountFields(remote,'local-project',root,new AbortController().signal).then(resolve,reject);};
 });
 document.querySelector<HTMLButtonElement>('#open')!.click();const fields=await opening;
 document.querySelector('#editor')!.append(fields.panel);
 const openedMs=performance.now()-started;
 assert(openedMs<5000,'OPEN_TIME_BUDGET');assert(apiCalls-baseline.api<30,'OPEN_API_BUDGET');
 const select=fields.panel.querySelectorAll('select')[1];select.value='prj';fields.panel.querySelector('input')!.value='x1';
 const directory=fields.directory()!;assert(directory.alias==='prj'&&directory.path==='x1','DIRECTORY_SELECTION');
 const commitStarted=performance.now();
 const committing=new Promise<Awaited<ReturnType<typeof client.remount>>>((resolve,reject)=>{
  document.querySelector<HTMLButtonElement>('#confirm')!.onclick=()=>{void client.binding(fixture.projectId).then(prior=>client.remount(prior,fields.access(),undefined,directory)).then(resolve,reject);};
 });
 document.querySelector<HTMLButtonElement>('#confirm')!.click();const updated=await committing;
 assert(updated.id===fixture.projectId&&updated.alias==='prj'&&updated.path==='x1','PROJECT_IDENTITY');
 const remountMs=performance.now()-commitStarted;assert(remountMs<5000,'REMOUNT_TIME_BUDGET');assert(apiCalls<30,'REMOUNT_API_BUDGET');
 await client.close();return {result:'passed',openedMs,remountMs,apiCalls,httpRequests,rows:1,state:'cold',backgroundLoad:'no model or compiler load',projectIdentityPreserved:true};
}
void main().then(report=>document.querySelector('#result')!.textContent=JSON.stringify(report)).catch(error=>document.querySelector('#result')!.textContent=JSON.stringify({result:'failed',code:error.message,apiCalls,httpRequests}));

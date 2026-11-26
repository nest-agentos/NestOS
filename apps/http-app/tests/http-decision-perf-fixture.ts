import {mkdir,writeFile,access} from 'node:fs/promises';
import path from 'node:path';
import {openLocalFSBackend} from '@nestos/vfsdriver-local';
import {createApplicationApi,createCertificates} from '@nestos/node-host/http';
import {NodeSqliteSidecarDb} from '@nestos/node-host/storage';
import {HttpViewClient} from '@nestos/app-transport/http';
import {authenticatedFetch,secureServers,close} from './tls-fixture';

const [directory,ui]=process.argv.slice(2),certs=path.join(directory,'certs'),data=path.join(directory,'data');
await mkdir(directory,{recursive:true});
await createCertificates(certs,['127.0.0.1']);
const backend=await openLocalFSBackend({rootDir:data,sidecarDir:path.join(directory,'meta'),createDb:NodeSqliteSidecarDb.open});
const api=await createApplicationApi(backend,data,{write:()=>{},close:async()=>{}});
const server=await secureServers(backend,data,ui,certs,api),auth=await authenticatedFetch(certs);
const peer=new HttpViewClient('fixture-seed',server.origin+'/api/application',auth.fetcher);
const root=await peer.start(),kanban=root.services.kanban!,actor=await kanban.currentPrincipal();
await Promise.all([root.services.projects.create('Project A'),root.services.projects.create('Project B')]);
const board=await kanban.create({id:'perf-board',title:'Performance board',scope:{kind:'system'},members:[{...actor,responsibility:'Review',roles:['coordinator','reviewer']}],policy:{requireEstimate:false,review:'assignee'}});
let revision=board.revision;
for(let i=0;i<100;i++){
 await kanban.execute(board.id,{operationId:'seed-'+i,expectedRevision:revision,command:{type:'append-record',record:{id:'decision-'+i,kind:'decision',title:'Decision '+i,content:'Fixture',rationale:'Fixture',itemIds:[],sources:[],externalRefs:[]}}});
 revision=(await kanban.read(board.id)).revision;
 await kanban.execute(board.id,{operationId:'confirm-'+i,expectedRevision:revision,command:{type:'review-record',recordId:'decision-'+i,accept:true}});
 revision=(await kanban.read(board.id)).revision;
}
await peer.close();auth.close();
await writeFile(path.join(directory,'ready.json'),JSON.stringify({origin:server.origin,certs,decisions:100,projects:2}));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;await api.close();await close(server.server);await backend.close();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());

const shutdown=setInterval(()=>{void access(path.join(directory,'stop')).then(()=>{clearInterval(shutdown);return stop();}).catch(()=>{});},100);

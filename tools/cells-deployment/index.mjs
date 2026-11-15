import path from 'node:path';
import {copyFile,rename,chmod,mkdir,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {artifact,json,save,fail,validId,digest} from './artifact.mjs';
import {command,ready,runningHash} from './guest.mjs';
/** External business plugin: its private options grant access to exactly one managed VM. */
export async function createServiceControl(options,ports={command,ready,hash:runningHash}){
 if(!validId(options.id)||!validId(options.vm)||['root','executable','identity','stateDirectory','server'].some(key=>typeof options[key]!=='string'||!path.isAbsolute(options[key])))throw fail('CELLS_CONTROLLER_CONFIGURATION_INVALID');
 await mkdir(options.stateDirectory,{recursive:true,mode:0o700});return new CellsDeployment(options,ports);
}
class CellsDeployment {
 constructor(options,ports){this.options=options;this.ports=ports;}
 async read(file){try{return await json(path.join(this.options.stateDirectory,file));}catch(error){if(error.code==='ENOENT')return;throw error;}}
 write(file,value){return save(path.join(this.options.stateDirectory,file),value);}
 check(request){if(request.serviceId!==this.options.id||!validId(request.operationId)||!validId(request.targetVersion)||!validId(request.expectedVersion))throw fail('SERVICE_REQUEST_INVALID');}
 async version(){
  if(!await this.ports.ready(this.options))throw fail('SERVICE_NOT_READY');
  const hash=await this.ports.hash(this.options),saved=await this.read('current.json');
  return {hash,id:saved?.sha256===hash?saved.version:'cells-'+hash.slice(0,20)};
 }
 async verified(id){
  const value=await artifact(this.options.root,id),proof=await this.read('artifact-'+id+'.json');
  if(!proof||proof.digest!==value.digest)throw fail('SERVICE_ARTIFACT_NOT_VERIFIED');return value;
 }
 async describe(){return {id:this.options.id,version:(await this.version()).id,build:{base:'source-checkout',directory:'.',command:['node','tools/cells-deployment/cli.mjs','build']},artifact:{format:'nestos.cells.release/1',manifest:'release.json',store:{base:'source-checkout',path:'release/cells'}}};}
 async verifyArtifact(request){
  const started=Date.now();
  try{if(request.serviceId!==this.options.id)throw fail('SERVICE_TARGET_MISMATCH');
   const value=await artifact(this.options.root,request.version);if(value.digest!==request.sha256)throw fail('OPERATION_RESULT_ARTIFACT_UNVERIFIED');
   if(request.sourceVersion&&request.sourceVersion!==value.value.commit)throw fail('OPERATION_RESULT_SOURCE_CHANGED');
   await this.write('artifact-'+request.version+'.json',{digest:value.digest});log(request,'artifact.verify','success',undefined,started);
  }catch(error){log(request,'artifact.verify','failure',error.code??'SERVICE_ARTIFACT_INVALID',started);throw error;}
 }
 async observe(request){
  this.check(request);const row=await this.read('operation-'+request.operationId+'.json');
  if(!row)return {state:'running'};
  if(!sameRequest(row.request,request))throw fail('SERVICE_REQUEST_CHANGED');
  if(row.state==='succeeded')return {state:'succeeded',version:request.targetVersion};
  if(row.state==='failed')return {state:'failed',code:row.code};
  const started=Date.now();
  try{const value=await this.verified(request.targetVersion);
   if(await this.ports.ready(this.options)&&await this.ports.hash(this.options)===value.value.sha256){
    await this.write('current.json',{version:request.targetVersion,sha256:value.value.sha256});
    await this.write('operation-'+request.operationId+'.json',{...row,state:'succeeded'});await this.write('pending.json',null);
    log(request,'health.verify','success',undefined,started);return {state:'succeeded',version:request.targetVersion};
   }
  }catch(error){log(request,'health.verify','failure',error.code??'SERVICE_HEALTH_UNAVAILABLE',started);}
  return {state:'running'};
 }
 lock(){
  const db=new DatabaseSync(path.join(this.options.stateDirectory,'service-lock.sqlite'));
  try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');return db;}catch{db.close();throw fail('SERVICE_OPERATION_BUSY');}
 }
 async inspect(request){const db=this.lock();try{return await this.observe(request);}finally{db.close();}}
 async submit(request){
  this.check(request);const started=Date.now(),db=this.lock();
  try{
   const existing=await this.read('operation-'+request.operationId+'.json');if(existing){if(!sameRequest(existing.request,request))throw fail('SERVICE_REQUEST_CHANGED');return;}
   if(await this.read('pending.json'))throw fail('SERVICE_OPERATION_PENDING');
   if((await this.version()).id!==request.expectedVersion)throw fail('SERVICE_VERSION_CHANGED');
   const value=await this.verified(request.targetVersion);
   await this.write('operation-'+request.operationId+'.json',{request,state:'running',startedAt:Date.now()});await this.write('pending.json',{operationId:request.operationId});
   await this.install(value,request);log(request,'service.restart','start',undefined,started);
   try{await this.ports.command('sudo',['-n','systemctl','restart','firecracker-workload@'+this.options.vm+'.service'],120000);await this.observe(request);}
   catch(error){log(request,'service.restart','failure',error.code??'SERVICE_SWITCH_UNKNOWN',started);}
  }catch(error){log(request,'service.admission','failure',error.code??'SERVICE_OPERATION_BUSY',started);throw error;}finally{db.close();}
 }
 async install(value,request){
  const temporary=this.options.executable+'.'+request.operationId+'.tmp';
  await copyFile(value.binary,temporary);if(digest(await readFile(temporary))!==value.value.sha256)throw fail('SERVICE_ARTIFACT_CHANGED');
  await chmod(temporary,0o755);await rename(temporary,this.options.executable);
 }
}
function log(request,stage,result,code,started=Date.now()){console.info(JSON.stringify({operation:'cells.delivery',operationId:request.operationId,stage,result,code,durationMs:Date.now()-started}));}

function sameRequest(a,b){return ['operationId','serviceId','expectedVersion','targetVersion'].every(key=>a[key]===b[key]);}

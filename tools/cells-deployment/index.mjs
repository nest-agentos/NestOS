import path from 'node:path';
import {copyFile,rename,chmod,mkdir,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {artifact,json,save,fail,validId,digest} from './artifact.mjs';
import {command,ready,runningHash,runningProcess,guestStorage,installedExecutable} from './guest.mjs';
/** External business plugin: its private options grant access to exactly one managed VM. */
export async function createServiceControl(options,ports){
 if(!validId(options.id)||!validId(options.vm)||['root','executable','identity','stateDirectory','server'].some(key=>typeof options[key]!=='string'||!path.isAbsolute(options[key])))throw fail('CELLS_CONTROLLER_CONFIGURATION_INVALID');
 ports??={command,ready,hash:runningHash,process:runningProcess,...(options.executable===installedExecutable?guestStorage(options):{})};
 await mkdir(options.stateDirectory,{recursive:true,mode:0o700});return new CellsDeployment(options,ports);
}
class CellsDeployment {
 constructor(options,ports){this.options=options;this.ports=ports;}
 async read(file){try{return await json(path.join(this.options.stateDirectory,file));}catch(error){if(error.code==='ENOENT')return;throw error;}}
 write(file,value){return save(path.join(this.options.stateDirectory,file),value);}
 check(request){
  if(request.serviceId!==this.options.id||!validId(request.operationId)||!validId(request.targetVersion)||!validId(request.expectedVersion))throw fail('SERVICE_REQUEST_INVALID');
  if((request.configSha256!==undefined||request.expectedConfigSha256!==undefined)&&
   ![request.configSha256,request.expectedConfigSha256].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw fail('CELLS_CONFIG_DIGEST_INVALID');
 }
 async configuration(){
  if(!this.ports.configHash||!this.ports.process)throw fail('CELLS_CONFIG_INSTALL_UNAVAILABLE');
  return this.ports.configHash();
 }
 async installedConfiguration(){
  if(!this.ports.readConfiguration)throw fail('CELLS_CONFIG_INSTALL_UNAVAILABLE');
  return this.ports.readConfiguration();
 }
 async version(withConfig=false){
  if(!await this.ports.ready(this.options))throw fail('SERVICE_NOT_READY');
  const process=withConfig?await this.ports.process(this.options):{hash:await this.ports.hash(this.options)};
  const saved=await this.read('current.json');
  return {...process,id:saved?.sha256===process.hash?saved.version:'cells-'+process.hash.slice(0,20)};
 }
 async verified(id){
  const value=await artifact(this.options.root,id),proof=await this.read('artifact-'+id+'.json');
  if(!proof||proof.digest!==value.digest)throw fail('SERVICE_ARTIFACT_NOT_VERIFIED');return value;
 }
 async describe(){
  const version=await this.version();
  if(this.ports.installedHash)await this.ports.installedHash();
  return {id:this.options.id,version:version.id,build:{base:'source-checkout',directory:'.',command:['node','tools/cells-deployment/cli.mjs','build']},artifact:{format:'nestos.cells.release/1',manifest:'release.json',store:{base:'source-checkout',path:'release/cells'}}};
 }
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
  if(row.state==='succeeded'||row.state==='unchanged')return {state:'succeeded',version:request.targetVersion,...(row.state==='unchanged'?{changed:false}:{})};
  if(row.state==='failed')return {state:'failed',code:row.code};
  const started=Date.now();
  try{const value=await this.verified(request.targetVersion);
   const verification=await this.runningRelease(value,request,row);
   if(verification){
    await this.write('current.json',{version:request.targetVersion,sha256:value.value.sha256,...verification});
    await this.write('operation-'+request.operationId+'.json',{...row,state:'succeeded'});await this.write('pending.json',null);
    log(request,'health.verify','success',undefined,started);return {state:'succeeded',version:request.targetVersion};
   }
  }catch(error){log(request,'health.verify','failure',error.code??'SERVICE_HEALTH_UNAVAILABLE',started);}
  return {state:'running'};
 }
 async runningRelease(value,request,row){
  if(!await this.ports.ready(this.options))return;
  if(!request.configSha256)return await this.ports.hash(this.options)===value.value.sha256?{}:undefined;
  if(!row.restartRequested)return;
  const process=await this.ports.process(this.options);
  if(process.hash!==value.value.sha256||process.generation===row.previousGeneration)return;
  if(await this.installedHash()!==process.hash||await this.configuration()!==request.configSha256)return;
  return {configSha256:request.configSha256,generation:process.generation};
 }
 async unchanged(current,value,request){
  if(current.hash!==value.value.sha256||await this.installedHash()!==current.hash)return false;
  if(!request.configSha256)return true;
  const saved=await this.read('current.json');
  return saved?.generation===current.generation&&saved.configSha256===request.configSha256&&
   request.expectedConfigSha256===request.configSha256;
 }
 async checkConfiguration(request,config){
  if(!request.configSha256)return;
  if(!Buffer.isBuffer(config)||digest(config)!==request.configSha256)throw fail('CELLS_CONFIG_DIGEST_MISMATCH');
  if(await this.configuration()!==request.expectedConfigSha256)throw fail('CELLS_CONFIG_CHANGED');
 }
 lock(){
  const db=new DatabaseSync(path.join(this.options.stateDirectory,'service-lock.sqlite'));
  try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');return db;}catch{db.close();throw fail('SERVICE_OPERATION_BUSY');}
 }
 async inspectOperation(operationId){
  if(!validId(operationId))throw fail('SERVICE_REQUEST_INVALID');
  const row=await this.read('operation-'+operationId+'.json');
  return row ? this.inspect(row.request) : {state:'missing'};
 }
 async inspect(request){const db=this.lock();try{return await this.observe(request);}finally{db.close();}}
 async submit(request,config){
  this.check(request);const started=Date.now(),db=this.lock();
  try{
   const existing=await this.read('operation-'+request.operationId+'.json');if(existing){if(!sameRequest(existing.request,request))throw fail('SERVICE_REQUEST_CHANGED');return;}
   if(await this.read('pending.json'))throw fail('SERVICE_OPERATION_PENDING');
   await this.checkConfiguration(request,config);
   const current=await this.version(!!request.configSha256);
   if(current.id!==request.expectedVersion)throw fail('SERVICE_VERSION_CHANGED');
   const value=await this.verified(request.targetVersion);
   if(await this.unchanged(current,value,request)){
    const prior=await this.read('current.json');
    await this.write('current.json',{...prior,version:request.targetVersion,sha256:current.hash});
    await this.write('operation-'+request.operationId+'.json',{request,state:'unchanged'});
    log(request,'service.switch','unchanged',undefined,started);return;
   }
   const row={request,state:'running',startedAt:Date.now(),previousGeneration:current.generation};
   await this.write('operation-'+request.operationId+'.json',row);await this.write('pending.json',{operationId:request.operationId});
   if(!await this.installRelease(value,request,row,config))return;
   await this.restart(request,row,started);
  }catch(error){log(request,'service.admission','failure',error.code??'SERVICE_OPERATION_BUSY',started);throw error;}finally{db.close();}
 }
 async restart(request,row,started){
  try{
   if(request.configSha256){
    const {generation}=await this.ports.process(this.options);
    await this.write('operation-'+request.operationId+'.json',{...row,previousGeneration:generation,restartRequested:true});
   }
   log(request,'service.restart','start',undefined,started);
   if(this.ports.restart)await this.ports.restart();
   else await this.ports.command('sudo',['-n','systemctl','restart','firecracker-workload@'+this.options.vm+'.service'],120000);
   await this.observe(request);
  }catch(error){log(request,'service.restart','failure',error.code??'SERVICE_SWITCH_UNKNOWN',started);}
 }
 async installRelease(value,request,row,config){
  try{await this.install(value,request,config);return true;}
  catch(error){
   if(!config)throw error;
   if(['CELLS_CONFIG_CHANGED','CELLS_CONFIG_INVALID','CELLS_CONFIG_DIGEST_MISMATCH','CELLS_INSTALL_DIGEST_MISMATCH'].includes(error.code)){
    await this.write('operation-'+request.operationId+'.json',{...row,state:'failed',code:error.code});
    await this.write('pending.json',null);
   }
   return false;
  }
 }
 async install(value,request,config){
  if(this.ports.install){
   const started=Date.now();
   try{await this.ports.install(value,request,config);log(request,config?'release.install':'binary.install','success',undefined,started);}
   catch(error){log(request,config?'release.install':'binary.install','failure',error.code??'CELLS_BINARY_INSTALL_FAILED',started);throw error;}
   return;
  }
  if(config)throw fail('CELLS_CONFIG_INSTALL_UNAVAILABLE');
  const previous=await this.readExecutable();
  if(previous&&digest(previous)===value.value.sha256)return;
  if(previous&&this.options.keepPrevious)await this.backup(previous,request.operationId);
  const temporary=this.options.executable+'.'+request.operationId+'.tmp';
  await copyFile(value.binary,temporary);if(digest(await readFile(temporary))!==value.value.sha256)throw fail('SERVICE_ARTIFACT_CHANGED');
  await chmod(temporary,0o755);await rename(temporary,this.options.executable);
 }
 async installedHash(){
  if(this.ports.installedHash)return this.ports.installedHash();
  const bytes=await this.readExecutable();
  return bytes&&digest(bytes);
 }
 async readExecutable(){
  try{return await readFile(this.options.executable);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 async backup(bytes,operationId){
  await writeFile(path.join(this.options.stateDirectory,'previous-'+operationId),bytes,{flag:'wx',mode:0o700});
 }

}
function log(request,stage,result,code,started=Date.now()){console.info(JSON.stringify({operation:'cells.delivery',operationId:request.operationId,stage,result,code,durationMs:Date.now()-started}));}

function sameRequest(a,b){return ['operationId','serviceId','expectedVersion','targetVersion','configSha256','expectedConfigSha256'].every(key=>a[key]===b[key]);}

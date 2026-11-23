import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServiceControl} from './index.mjs';
import {packageArtifact,digest,save} from './artifact.mjs';
import {redeploy, targetsFor} from './redeploy.mjs';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'cells-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(root+'/tools/cells/target/release',{recursive:true});await writeFile(root+'/tools/cells/target/release/cells','candidate');
 await writeFile(root+'/running','original');const value=await packageArtifact(root,'a'.repeat(40));
 const options={id:'service',vm:'cell',root,executable:root+'/running',identity:'/key',stateDirectory:root+'/private',server:'/server'};
 let hash=digest(Buffer.from('original')),calls=0;
 const ports={ready:async()=>true,hash:async()=>hash,command:async()=>{calls++;hash=value.value.sha256;}};
 const control=await createServiceControl(options,ports),request={operationId:'replace',serviceId:'service',expectedVersion:(await control.describe()).version,targetVersion:value.value.id};
 const verify=()=>control.verifyArtifact({operationId:'build',serviceId:'service',version:value.value.id,sha256:value.digest});
 return {control,options,ports,request,value,verify,calls:()=>calls,setHash:value=>{hash=value;}};
}
test('verifies artifacts, switches only the bound VM and recovers the same receipt without replay',async t=>{
 const f=await fixture(t);await assert.rejects(f.control.submit(f.request),{code:'SERVICE_ARTIFACT_NOT_VERIFIED'});
 await assert.rejects(f.control.verifyArtifact({operationId:'build',serviceId:'service',version:f.value.value.id,sha256:f.value.digest,sourceVersion:'wrong'}),{code:'OPERATION_RESULT_SOURCE_CHANGED'});
 await f.verify();await f.control.submit(f.request);assert.equal(f.calls(),1);
 assert.deepEqual(await f.control.inspect(f.request),{state:'succeeded',version:f.request.targetVersion});
 const recovered=await createServiceControl(f.options,f.ports);await recovered.submit(f.request);assert.equal(f.calls(),1);
 assert.equal((await recovered.describe()).version,f.request.targetVersion);
 await assert.rejects(recovered.submit({...f.request,targetVersion:'changed'}),{code:'SERVICE_REQUEST_CHANGED'});
});
test('rejects target drift and artifact modification before switching',async t=>{
 const f=await fixture(t);await f.verify();
 await assert.rejects(f.control.submit({...f.request,expectedVersion:'stale'}),{code:'SERVICE_VERSION_CHANGED'});
 await writeFile(f.value.binary,'tampered');await assert.rejects(f.control.submit(f.request),{code:'SERVICE_ARTIFACT_INVALID'});assert.equal(f.calls(),0);
});
test('preserves unknown replacement and serializes later switches until its health is proven',async t=>{
 const f=await fixture(t);await f.verify();f.ports.command=async()=>{throw Object.assign(Error('timeout'),{code:'SERVICE_COMMAND_TIMEOUT'});};
 const control=await createServiceControl(f.options,f.ports);await control.submit(f.request);
 assert.deepEqual(await control.inspect(f.request),{state:'running'});
 await assert.rejects(control.submit({...f.request,operationId:'second'}),{code:'SERVICE_OPERATION_PENDING'});
 f.setHash(f.value.value.sha256);assert.deepEqual(await control.inspect(f.request),{state:'succeeded',version:f.request.targetVersion});
});
test('uses a SQLite OS lock to reject concurrent controllers before a second mutation',async t=>{
 const f=await fixture(t);await f.verify();let release;f.ports.command=()=>new Promise(resolve=>{release=resolve;});
 const first=f.control.submit(f.request);while(!release)await new Promise(resolve=>setTimeout(resolve,2));
 const second=await createServiceControl(f.options,f.ports);await assert.rejects(second.submit({...f.request,operationId:'other'}));
 f.setHash(f.value.value.sha256);release();await first;
});

test('redeploy defaults to both targets and builds a shared artifact once', async t => {
 const f=await fixture(t);
 const root=f.options.root, calls=[];
 const controlFor=async (_root,target)=>{
  let hash=digest(Buffer.from('original'));
  return createServiceControl({...f.options,id:target,stateDirectory:root+'/'+target,keepPrevious:true},{
   ready:async()=>true,hash:async()=>hash,restart:async()=>{
    calls.push(target);hash=digest(await readFile(f.options.executable));
   },
  });
 };
 let builds=0;
 const report=await redeploy(root,targetsFor(),{controlFor,build:async()=>{builds++;return f.value;}});
 assert.equal(builds,1);
 assert.deepEqual(calls,['cells-x1','local']);
 assert.deepEqual(report.targets.map(row=>row.state),['succeeded','succeeded']);
 assert.equal(await readFile(root+'/cells-x1/previous-'+report.operationId,'utf8'),'original');
 await assert.rejects(readFile(root+'/local/previous-'+report.operationId),{code:'ENOENT'});
});

test('preflight failure prevents build and an unknown first restart prevents a second switch', async t => {
 const f=await fixture(t);
 let builds=0;
 const build=async()=>{builds++;return f.value;};
 const controlFor=async (_root,target)=>{
  if(target==='local')throw Object.assign(Error('inactive'),{code:'SERVICE_NOT_READY'});
  return {describe:async()=>({version:'old'})};
 };
 const blocked=await redeploy(f.options.root,targetsFor(),{controlFor,build});
 assert.equal(builds,0);
 assert.deepEqual(blocked.targets.map(row=>row.state),['skipped','failed']);
 let submissions=0;
 const pending=await redeploy(f.options.root,targetsFor(),{build,controlFor:async()=>({
  describe:async()=>({version:'old'}),verifyArtifact:async()=>{},
  submit:async()=>{submissions++;},inspect:async()=>({state:'running'}),
 })});
 assert.equal(submissions,1);
 assert.deepEqual(pending.targets.map(row=>row.state),['running','skipped']);
});

import {expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {localServiceControl} from '../src/runtime/service-control';
it('describes the running child version while the launcher still records its predecessor',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'nestos-service-version-'));
    try {
        await mkdir(path.join(root,'scripts'));
        await writeFile(path.join(root,'scripts/httpd-launch-state.mjs'),"export const readLaunch=async()=>({serviceId:'test-service',currentRelease:'previous'});export const launcherAlive=async()=>true;");
        await writeFile(path.join(root,'scripts/httpd-runtime.mjs'),"export const releasesRoot=root=>root+'/release/httpd';");
        vi.stubEnv('NESTOS_HTTPD_SERVICE_ID','test-service');vi.stubEnv('INIT_CWD',root);vi.stubEnv('NESTOS_HTTPD_VERSION','running-child');
        expect(await localServiceControl()!.describe()).toMatchObject({id:'test-service',version:'running-child'});
    } finally {vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
it('verifies the manifest digest in its own service store and rejects mismatches or other services',async()=>{
 const {createHash}=await import('node:crypto'),root=await mkdtemp(path.join(tmpdir(),'nestos-service-artifact-'));
 try{
  await mkdir(path.join(root,'scripts'));await mkdir(path.join(root,'release/httpd/candidate'),{recursive:true});
  await writeFile(path.join(root,'scripts/httpd-launch-state.mjs'),"export const readLaunch=async()=>({serviceId:'test-service'});export const launcherAlive=async()=>true;");
  await writeFile(path.join(root,'scripts/httpd-runtime.mjs'),"export const releasesRoot=root=>root+'/release/httpd';export const releaseDirectory=(root,id)=>{if(id!=='candidate')throw Error('Invalid release');return root+'/'+id};export const verifyRelease=()=>({id:'candidate'});");
  const manifest='verified build manifest';await writeFile(path.join(root,'release/httpd/candidate/release.json'),manifest);
  vi.stubEnv('NESTOS_HTTPD_SERVICE_ID','test-service');vi.stubEnv('INIT_CWD',root);
  const control=localServiceControl()!,request={operationId:'build',serviceId:'test-service',version:'candidate',sha256:createHash('sha256').update(manifest).digest('hex')};
  await expect(control.verifyArtifact!(request)).resolves.toBeUndefined();
  await expect(control.verifyArtifact!({...request,sha256:'a'.repeat(64)})).rejects.toMatchObject({code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
  await expect(control.verifyArtifact!({...request,serviceId:'other'})).rejects.toMatchObject({code:'HTTPD_SERVICE_MISMATCH'});
 }finally{vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {serviceControlModules} from '../src/runtime/service-control-modules';
afterEach(()=>vi.unstubAllEnvs());
it('dispatches only to the explicitly registered target and keeps its private options out of descriptors',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'service-module-'));
 try{const module=path.join(root,'controller.mjs');await writeFile(module,"export const createServiceControl=async options=>({describe:async()=>({id:options.id,version:'node-version'}),submit:async request=>{if(request.serviceId!==options.id)throw Error('wrong target')},inspect:async()=>({state:'succeeded',version:'node-version'})});");
  vi.stubEnv('NESTOS_SERVICE_MODULES',JSON.stringify([{id:'node',module,options:{id:'node',credential:'private'}}]));
  const primary={describe:async()=>({id:'web',version:'web-version'}),submit:vi.fn(),inspect:vi.fn()},control=serviceControlModules(primary)!;
  expect(await control.describe()).toEqual({id:'web',version:'web-version'});
  expect(await control.describe('node')).toEqual({id:'node',version:'node-version'});
  await control.submit({operationId:'replace',serviceId:'node',expectedVersion:'old',targetVersion:'new'});expect(primary.submit).not.toHaveBeenCalled();
  await expect(control.describe('unknown')).rejects.toMatchObject({code:'SERVICE_TARGET_UNAVAILABLE'});
 }finally{await rm(root,{recursive:true,force:true});}
});
it('keeps the primary service available when an unrelated plugin cannot load',async()=>{
 vi.stubEnv('NESTOS_SERVICE_MODULES',JSON.stringify([{id:'node',module:'/missing/controller.mjs'}]));
 const control=serviceControlModules({describe:async()=>({id:'web',version:'v'}),submit:vi.fn(),inspect:vi.fn()})!;
 expect(await control.describe('web')).toMatchObject({id:'web'});
 await expect(control.describe('node')).rejects.toBeDefined();
});

it('requires the admin-bound Cells project and rechecks authorization before submitting a self update',async()=>{
 const id='httpd-bound',project={serverId:'cells-node',serverProjectId:'project-a',principalId:'owner',alias:'prj',root:'/x1'};
 vi.stubEnv('NESTOS_HTTPD_SERVICE_ID',id);
 vi.stubEnv('NESTOS_SERVICE_PROJECTS',JSON.stringify([{serviceId:'httpd',...project}]));
 const primary={describe:async()=>({id,version:'old'}),verifyArtifact:vi.fn(),submit:vi.fn(),inspect:vi.fn(async()=>({state:'succeeded' as const,version:'new'}))};
 const control=serviceControlModules(primary)!;
 expect(await control.describeForProject!('httpd',project)).toEqual({id,version:'old',project});
 await expect(control.describeForProject!('httpd',{...project,serverProjectId:'project-b'})).rejects.toMatchObject({code:'SERVICE_PROJECT_UNAUTHORIZED'});
 await expect(control.describeForProject!('httpd',{...project,root:'/other'})).rejects.toMatchObject({code:'SERVICE_PROJECT_UNAUTHORIZED'});
 const verification={operationId:'build',serviceId:id,version:'new',sha256:'a'.repeat(64),sourceVersion:'b'.repeat(40),project};
 await control.verifyArtifact!(verification);
 await expect(control.verifyArtifact!({...verification,project:{...project,root:'/other'}})).rejects.toMatchObject({code:'SERVICE_PROJECT_UNAUTHORIZED'});
 expect(primary.verifyArtifact).toHaveBeenCalledExactlyOnceWith(verification);
 const request={operationId:'swap',serviceId:id,expectedVersion:'old',targetVersion:'new',project};
 await control.submit(request);
 expect(primary.submit).toHaveBeenCalledExactlyOnceWith(request);
 vi.stubEnv('NESTOS_SERVICE_PROJECTS','[]');
 await expect(control.submit(request)).rejects.toMatchObject({code:'SERVICE_PROJECT_UNAUTHORIZED'});
 await expect(control.inspect(request)).resolves.toMatchObject({state:'succeeded',version:'new'});
});

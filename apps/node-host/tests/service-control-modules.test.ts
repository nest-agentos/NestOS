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

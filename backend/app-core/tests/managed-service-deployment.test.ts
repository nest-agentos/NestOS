import {afterEach,expect,it,vi} from 'vitest';
import {createVFS,MemoryBackend} from '@nestos/vfs-core';
import {managedServiceDeployment} from '../src/presets/managed-service-deployment';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0))await close();});
it('selects only an explicitly declared authorized service and verifies source before trusting replacement',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
 const control={describe:async()=>({id:'service',version:'old'}),submit:vi.fn(async()=>{}),inspect:vi.fn(async()=>({state:'succeeded' as const,version:'candidate'}))},verify=vi.fn(async()=>{});
 const managed=managedServiceDeployment(control,async()=>({fs,dispose:async()=>{}}),verify)!;
 const input={id:'switch',item:{id:'task'},board:{id:'board'},snapshot:{version:'source'},context:{version:'candidate'}} as never;
 expect(await managed.prepare(input)).toBeUndefined();expect(await managed.describe!({id:'task'} as never)).toBeUndefined();
 await fs.driver.createFile({parentPath:'/workspace/_nestos/etc',name:'deployment.json',content:JSON.stringify({schema:1,serviceId:'other'}),recursive:true});expect(await managed.prepare(input)).toBeUndefined();
 await fs.driver.writeContent('/workspace/_nestos/etc/deployment.json',JSON.stringify({schema:1,serviceId:'service'}));
 expect(await managed.describe!({id:'task'} as never)).toEqual({id:'service',version:'old'});
 const request=await managed.prepare(input);expect(request).toEqual({operationId:'switch',serviceId:'service',expectedVersion:'old',targetVersion:'candidate'});
 await managed.submit(request!);expect(control.submit).toHaveBeenCalledOnce();
 const result=await managed.inspect({id:'switch',managed:request,snapshot:{sourceVersion:'s',targetVersion:'t'}} as never);expect(result).toMatchObject({state:'succeeded',output:{operationId:'switch',version:'candidate'}});expect(verify).toHaveBeenCalledOnce();
 verify.mockRejectedValueOnce(Object.assign(new Error('changed'),{code:'OPERATION_SOURCE_CHANGED_REBUILD'}));await expect(managed.inspect({managed:request} as never)).rejects.toMatchObject({code:'OPERATION_SOURCE_CHANGED_REBUILD'});
});

it('binds each task to its selected controller and rejects changing a successfully built target',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
 const describe=vi.fn(async(id?:string)=>({id:id!,version:'running'}));
 const managed=managedServiceDeployment({describe,submit:vi.fn(),inspect:vi.fn()},async()=>({fs,dispose:async()=>{}}),async()=>{})!;
 await fs.driver.createFile({parentPath:'/workspace/_nestos/etc',name:'deployment.json',recursive:true,content:JSON.stringify({schema:2,defaultServiceId:'web',bindings:{task:'node'}})});
 expect(await managed.describe!({id:'task'} as never)).toMatchObject({id:'node'});
 expect(await managed.describe!({id:'other'} as never)).toMatchObject({id:'web'});
 const input={id:'switch',item:{id:'task'},context:{version:'candidate',deployment:{serviceId:'node'}}} as never;
 expect(await managed.prepare(input)).toMatchObject({serviceId:'node',targetVersion:'candidate'});
 await fs.driver.writeContent('/workspace/_nestos/etc/deployment.json',JSON.stringify({schema:2,defaultServiceId:'web'}));
 await expect(managed.prepare(input)).rejects.toMatchObject({code:'SERVICE_TARGET_CHANGED_REBUILD'});
});

it('freezes the admitted project into build evidence and rechecks the current binding at dispatch',async()=>{
 const {manager}=await createVFS({rootBackend:new MemoryBackend()});closes.push(()=>manager.dispose());const fs=await manager.openFileSystem('/');
 await fs.driver.createFile({parentPath:'/workspace/_nestos/etc',name:'deployment.json',recursive:true,content:JSON.stringify({schema:1,serviceId:'httpd'})});
 const project={serverId:'cells',serverProjectId:'self',principalId:'owner',alias:'prj',root:'/x1'};
 let current=project;
 const describeForProject=vi.fn(async(_id:string,project:typeof current)=>({id:'httpd-1',version:'old',project,
  build:{base:'source-checkout' as const,command:['build'],directory:'.'},
  artifact:{format:'release',manifest:'release.json',store:{base:'source-checkout' as const,path:'release/httpd'}}}));
 const control={describe:vi.fn(),describeForProject,submit:vi.fn(async()=>{}),inspect:vi.fn()};
 const managed=managedServiceDeployment(control,async()=>({fs,dispose:async()=>{},project:async()=>current}),async()=>{})!;
 const item={id:'self-upgrade'} as never;
 const {deploymentProjectDigest}=await import('../src/presets/managed-service-deployment');
 const input={id:'job',item,context:{version:'new',deployment:{serviceId:'httpd-1',projectDigest:deploymentProjectDigest(project)}}} as never;
 const request=await managed.prepare(input);
 expect(request).toMatchObject({serviceId:'httpd-1',project});
 current={...project,root:'/elsewhere'};
 await expect(managed.prepare(input)).rejects.toMatchObject({code:'SERVICE_PROJECT_CHANGED_REBUILD'});
 await expect(managed.submit(request!,item)).rejects.toMatchObject({code:'SERVICE_PROJECT_CHANGED_REBUILD'});
 expect(control.submit).not.toHaveBeenCalled();
 current=project;await managed.submit(request!,item);
 expect(control.submit).toHaveBeenCalledExactlyOnceWith(request);
});

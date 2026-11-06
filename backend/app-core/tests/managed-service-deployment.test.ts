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

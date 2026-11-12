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

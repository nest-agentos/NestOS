import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {reportTransferScript} from '../src/report-transfer-script';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it('reports the exact rejected relative path and type without following the symbolic link',async()=>{
 const root=await mkdtemp(join(tmpdir(),'kanban-report-'));roots.push(root);
 const directory=join(root,'_nestos/kanban/artifacts/bin');await mkdir(directory,{recursive:true});
 await writeFile(join(root,'outside'),'private fixture body');await symlink(join(root,'outside'),join(directory,'pnpm'));
 const result=spawnSync('python3',['-c',reportTransferScript,JSON.stringify({source:root,target:join(root,'delivery'),mode:'inspect',maxFiles:100,maxBytes:4096})],{encoding:'utf8'});
 expect(result.status).toBe(1);expect(JSON.parse(result.stdout)).toMatchObject({code:'SOFTWARE_REPORT_TYPE_UNSUPPORTED',path:'_nestos/kanban/artifacts/bin/pnpm',kind:'symlink'});
 expect(result.stdout).not.toContain('private fixture body');
 await rm(join(directory,'pnpm'));await writeFile(join(directory,'report.json'),'{}');
 const next=spawnSync('python3',['-c',reportTransferScript,JSON.stringify({source:root,target:join(root,'delivery'),mode:'inspect',maxFiles:100,maxBytes:4096})],{encoding:'utf8'});
 expect(next.status).toBe(0);expect(JSON.parse(next.stdout).fileCount).toBe(1);
});

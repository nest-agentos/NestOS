import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyGitIntegration} from '../src/integration';
const exec=promisify(execFile),paths:string[]=[];afterEach(async()=>{for(const path of paths.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'changes-integration-'));paths.push(root);
 const git=async(cwd:string,args:string[])=>{try{const r=await exec('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{cwd});return {...r,code:0};}catch(error){const e=error as any;return {stdout:e.stdout??'',stderr:e.stderr??'',code:e.code};}};
 await git(root,['init','-q']);const original='first\nsecond\nthird\nfourth\nfifth\n';
 await writeFile(join(root,'shared.txt'),original);await git(root,['add','.']);await git(root,['commit','-qm','base']);const base=(await git(root,['rev-parse','HEAD'])).stdout.trim();
 await git(root,['worktree','add','-qb','source','source',base]);
 const source=join(root,'source');await writeFile(join(source,'shared.txt'),original.replace('first','source'));
 await writeFile(join(root,'shared.txt'),original.replace('fifth','target'));await git(root,['add','shared.txt']);await git(root,['commit','-qm','independent target']);const previous=(await git(root,['rev-parse','HEAD'])).stdout.trim();
 const process={nativeShell:{exec:async(_program:string,args:string[],opts:any)=>git(opts.cwd.replaceAll('/workspace',root),args.map(arg=>arg.replaceAll('/workspace',root)))}} as any;
 const input=(target:string)=>({previousTarget:previous,actualTarget:target,reportedTarget:target,sources:[{sourceHead:base,directory:'/workspace/source',repositories:[{path:'.',head:base,dirty:true}]}]});
 return {root,source,git,base,previous,process,input,original};
}
it('accepts the exact three-way result while leaving source HEAD, content and index untouched',async()=>{
 const f=await fixture();await writeFile(join(f.root,'shared.txt'),f.original.replace('first','source').replace('fifth','target'));await f.git(f.root,['add','shared.txt']);await f.git(f.root,['commit','-qm','integrate']);
 const target=(await f.git(f.root,['rev-parse','HEAD'])).stdout.trim(),before=(await f.git(f.source,['status','--porcelain'])).stdout;
 await verifyGitIntegration(f.process,f.input(target));expect((await f.git(f.source,['rev-parse','HEAD'])).stdout.trim()).toBe(f.base);expect((await f.git(f.source,['status','--porcelain'])).stdout).toBe(before);
});
it('rejects missing source effects and additional unauthorized edits',async()=>{
 const f=await fixture();await expect(verifyGitIntegration(f.process,f.input(f.previous))).rejects.toMatchObject({code:'OPERATION_RESULT_BATCH_INCOMPLETE'});
 await writeFile(join(f.root,'shared.txt'),f.original.replace('first','source').replace('second','unexpected').replace('fifth','target'));await f.git(f.root,['add','shared.txt']);await f.git(f.root,['commit','-qm','incorrect']);
 await expect(verifyGitIntegration(f.process,f.input((await f.git(f.root,['rev-parse','HEAD'])).stdout.trim()))).rejects.toMatchObject({code:'OPERATION_RESULT_BATCH_INCOMPLETE'});
});

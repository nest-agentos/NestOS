import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {processIdentity} from '../httpd-process.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(){
 const root=await mkdtemp(path.join(tmpdir(),'httpd-launcher-'));await mkdir(path.join(root,'scripts'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 for(const file of ['httpd-launcher.mjs','httpd-launch-state.mjs','httpd-child.mjs','httpd-process.mjs'])await writeFile(path.join(root,'scripts',file),await readFile(new URL('../'+file,import.meta.url)));
 await writeFile(path.join(root,'scripts/httpd-runtime.mjs'),`export const hostArguments=()=>[],hostEnvironment=()=>process.env,runtimePaths=()=>({runtime:'unused'}),runtimeLog=()=>({write(){},close(){}}),releaseDirectory=(r,id)=>r+'/'+id,verifyRelease=()=>{};`);
 await writeFile(path.join(root,'scripts/httpd-launch-health.mjs'),`import{existsSync}from'node:fs';export const launchHealth=root=>Object.assign(async id=>id!=='bad'&&(id!=='delayed'||existsSync(root+'/allow')),{timeoutMs:400});`);
 const releases=path.join(root,'releases');for(const id of ['first','next','bad','delayed']){await mkdir(path.join(releases,id,'server'),{recursive:true});await writeFile(path.join(releases,id,'server/main.js'),`process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);}
 await writeFile(path.join(releases,'current.json'),'{"id":"first"}');
 await writeFile(path.join(root,'runner.mjs'),`import{launcherCommand}from'./scripts/httpd-launcher.mjs';await launcherCommand(process.cwd(),process.cwd()+'/releases',process.argv[2],process.argv.slice(3));`);
 const env={...process.env,NESTOS_HTTPD_CONTROL_DIR:path.join(root,'control')},runners=[];
 const run=(command,args=[])=>{const child=spawn(process.execPath,['runner.mjs',command,...args],{cwd:root,env,stdio:'ignore'});runners.push(child);return child;};
 const state=async()=>{const dirs=await import('node:fs/promises').then(fs=>fs.readdir(env.NESTOS_HTTPD_CONTROL_DIR)).catch(()=>[]);return dirs.length?readFile(path.join(env.NESTOS_HTTPD_CONTROL_DIR,dirs[0],'release.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return;throw error;}):undefined;};
 const wait=async predicate=>{const end=Date.now()+6000;while(Date.now()<end){const s=await state();if(s&&await predicate(s))return s;await sleep(20);}throw new Error('STATE_TIMEOUT');};
 return{root,releases,run,state,wait,close:async()=>{const stop=run('stop',['--timeout-ms','3000']);await Promise.race([once(stop,'exit'),sleep(3500)]);for(const p of runners)if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');const s=await state();if(s?.child&&await processIdentity(s.child.pid))process.kill(s.child.pid,'SIGKILL');await rm(root,{recursive:true,force:true});}};
}
test('switches once, rolls a bad candidate back and does not restart after stop',async()=>{const f=await fixture();try{
 f.run('start');const first=await f.wait(s=>s.healthyAt);const launcher=first.launcher.pid;
 const change=f.run('switch',['next','--expected-current','first','--operation-id','switch-next','--timeout-ms','5000']);assert.equal((await once(change,'exit'))[0],0);
 const next=await f.wait(s=>s.receipts?.['switch-next']);assert.equal(next.currentRelease,'next');assert.equal(next.launcher.pid,launcher);
 const bad=f.run('switch',['bad','--expected-current','next','--operation-id','switch-bad','--timeout-ms','5000']);assert.equal((await once(bad,'exit'))[0],1);
 const rolled=await f.state();assert.equal(rolled.currentRelease,'next');assert.equal(rolled.receipts['switch-bad'].code,'HTTPD_SWITCH_ROLLED_BACK');
 const stop=f.run('stop',['--timeout-ms','5000']);assert.equal((await once(stop,'exit'))[0],0);await sleep(300);assert.equal((await f.state()).desiredState,'stopped');assert.equal(await processIdentity((await f.state()).child?.pid),undefined);
 }finally{await f.close();}});
test('recovers an in-flight switch after launcher death without starting a second candidate',async()=>{const f=await fixture();try{
 f.run('start');await f.wait(s=>s.healthyAt);f.run('switch',['delayed','--operation-id','recover','--timeout-ms','5000']);
 const pending=await f.wait(s=>s.operation?.phase==='checking'&&s.childRelease==='delayed');process.kill(pending.launcher.pid,'SIGKILL');await sleep(50);
 const candidate=pending.child.pid;f.run('start');await f.wait(s=>s.launcher?.pid!==pending.launcher.pid&&s.child?.pid===candidate);
 await writeFile(path.join(f.root,'allow'),'yes');const settled=await f.wait(s=>s.receipts?.recover);assert.equal(settled.receipts.recover.result,'success');assert.equal(settled.child.pid,candidate);
 }finally{await f.close();}});

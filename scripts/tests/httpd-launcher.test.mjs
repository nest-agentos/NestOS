import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {processIdentity} from '../httpd-process.mjs';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(managed=false){
 const root=await mkdtemp(path.join(tmpdir(),'httpd-launcher-'));await mkdir(path.join(root,'scripts'));await writeFile(path.join(root,'package.json'),'{"type":"module"}');
 for(const file of ['httpd-launcher.mjs','httpd-retention.mjs','httpd-build-cache.mjs','local-library-lock.mjs','httpd-launch-state.mjs','httpd-child.mjs','httpd-process.mjs','httpd-diagnostics.mjs'])await writeFile(path.join(root,'scripts',file),await readFile(new URL('../'+file,import.meta.url)));
 await writeFile(path.join(root,'scripts/httpd-runtime.mjs'),`import{appendFileSync}from'node:fs';export const hostArguments=()=>[],hostEnvironment=()=>process.env,runtimePaths=()=>({runtime:process.env.NESTOS_HTTPD_TEST_ROOT+'/runtime.log'}),runtimeLog=file=>({write(chunk){appendFileSync(file,chunk,{mode:0o600});},close(){}}),releaseDirectory=(r,id)=>r+'/'+id,verifyRelease=()=>{};`);
 await writeFile(path.join(root,'scripts/httpd-launch-health.mjs'),`import{existsSync}from'node:fs';export const launchHealth=root=>Object.assign(async id=>id!=='bad'&&(id!=='delayed'||existsSync(root+'/allow')),{timeoutMs:400});`);
 const releases=path.join(root,managed?'release/httpd':'releases');for(const id of ['first','next','bad','delayed']){await mkdir(path.join(releases,id,'server'),{recursive:true});await writeFile(path.join(releases,id,'server/main.js'),`process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);}
 await writeFile(path.join(releases,'current.json'),'{"id":"first"}');
 await writeFile(path.join(root,'runner.mjs'),`import{launcherCommand}from'./scripts/httpd-launcher.mjs';import{setLifecycleLog}from'./scripts/httpd-process.mjs';import{runtimeLog,runtimePaths}from'./scripts/httpd-runtime.mjs';const output=runtimeLog(runtimePaths().runtime);setLifecycleLog(chunk=>output.write(chunk));await launcherCommand(process.cwd(),process.env.NESTOS_HTTPD_TEST_RELEASES,process.argv[2],process.argv.slice(3));`);
 const env={...process.env,NESTOS_HTTPD_TEST_RELEASES:releases,NESTOS_HTTPD_CONTROL_DIR:path.join(root,'control'),NESTOS_HTTPD_TEST_ROOT:root},runners=[];
 const run=(command,args=[])=>{const child=spawn(process.execPath,['runner.mjs',command,...args],{cwd:root,env,stdio:'ignore'});runners.push(child);return child;};
 const state=async()=>{const dirs=await import('node:fs/promises').then(fs=>fs.readdir(env.NESTOS_HTTPD_CONTROL_DIR)).catch(()=>[]);return dirs.length?readFile(path.join(env.NESTOS_HTTPD_CONTROL_DIR,dirs[0],'release.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return;throw error;}):undefined;};
 const saveState=async value=>{const {readdir}=await import('node:fs/promises');const [directory]=await readdir(env.NESTOS_HTTPD_CONTROL_DIR);await writeFile(path.join(env.NESTOS_HTTPD_CONTROL_DIR,directory,'release.json'),JSON.stringify(value));};
 const wait=async predicate=>{const end=Date.now()+6000;while(Date.now()<end){const s=await state();if(s&&await predicate(s))return s;await sleep(20);}throw new Error('STATE_TIMEOUT');};
 const logs=async()=>(await readFile(path.join(root,'runtime.log'),'utf8').catch(()=>'' )).split('\n').filter(line=>line.startsWith('[HTTPProcess] ')).map(line=>JSON.parse(line.slice(14)));
 const waitLog=async predicate=>{const end=Date.now()+6000;while(Date.now()<end){const found=(await logs()).find(predicate);if(found)return found;await sleep(20);}throw new Error('LOG_TIMEOUT');};
 return{root,releases,run,state,saveState,wait,logs,waitLog,close:async()=>{const stop=run('stop',['--timeout-ms','3000']);await Promise.race([once(stop,'exit'),sleep(3500)]);for(const p of runners)if(p.exitCode===null&&!p.signalCode)p.kill('SIGKILL');const s=await state();if(s?.child&&await processIdentity(s.child.pid))process.kill(s.child.pid,'SIGKILL');await rm(root,{recursive:true,force:true});}};
}
for(const command of ['start','restart'])test(`${command} resets an exhausted budget after the launcher stopped`,async()=>{const f=await fixture();try{
 const first=f.run('start');await f.wait(s=>s.healthyAt);
 const exited=once(first,'exit'),stop=f.run('stop',['--timeout-ms','5000']);assert.equal((await once(stop,'exit'))[0],0);await exited;
 const previous=await f.state();await f.saveState({...previous,restarts:3,healthyAt:1});
 await writeFile(path.join(f.releases,'current.json'),'{"id":"next"}');f.run(command);
 const recovered=await f.wait(s=>s.childRelease==='next'&&s.healthyAt>1);
 assert.equal(recovered.restarts,1);assert.equal(recovered.serviceId,previous.serviceId);assert.deepEqual(recovered.receipts,previous.receipts);
 }finally{await f.close();}});
test('launcher recovery preserves the retry limit for a running service',async()=>{const f=await fixture();try{
 const first=f.run('start');const running=await f.wait(s=>s.healthyAt);
 const exited=once(first,'exit');process.kill(first.pid,'SIGKILL');await exited;
 process.kill(running.child.pid,'SIGTERM');while(await processIdentity(running.child.pid))await sleep(20);
 await f.saveState({...await f.state(),desiredState:'running',restarts:3});
 const resumed=f.run('start');assert.equal((await once(resumed,'exit'))[0],1);
 const stopped=await f.state();assert.equal(stopped.desiredState,'stopped');assert.equal(stopped.restarts,3);
 }finally{await f.close();}});
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

test('persists an observed SIGKILL and correlates the replacement health check',async()=>{const f=await fixture();try{
 f.run('start');const first=await f.wait(s=>s.healthyAt);await f.waitLog(e=>e.stage==='server.import'&&e.result==='success');
 process.kill(first.child.pid,'SIGKILL');
 const exit=await f.waitLog(e=>e.stage==='child.exit'&&e.pid===first.child.pid);
 assert.equal(exit.signal,'SIGKILL');assert.equal(exit.exitCode,null);assert.equal(exit.expected,false);assert.equal(exit.code,'HTTPD_CHILD_SIGNALLED');
 assert.equal(exit.version,'first');assert.equal(exit.serviceId,first.serviceId);assert.ok(exit.durationMs>=0);assert.ok(exit.time);
 const replacement=await f.wait(s=>s.child?.pid!==first.child.pid&&s.healthyAt);
 assert.equal(replacement.lastChildExit.operationId,exit.operationId);
 const server=await f.waitLog(e=>e.stage==='process.start'&&e.pid===first.child.pid);
 assert.equal(server.operationId,exit.operationId);
 const logs=await f.logs(),health=logs.filter(e=>e.stage==='launcher.health'&&e.result==='success').at(-1);
 assert.ok(logs.some(e=>e.stage==='launcher.restart'&&e.operationId===health.operationId));
 }finally{await f.close();}});

test('records expected child shutdown and a launcher exit receipt',async()=>{const f=await fixture();try{
 const launcher=f.run('start'),first=await f.wait(s=>s.healthyAt);
 await f.waitLog(e=>e.stage==='server.import'&&e.result==='success');
 const exited=once(launcher,'exit'),stop=f.run('stop',['--timeout-ms','5000']);assert.equal((await once(stop,'exit'))[0],0);await exited;
 const exit=await f.waitLog(e=>e.stage==='child.exit'&&e.pid===first.child.pid);
 assert.equal(exit.expected,true);assert.equal(exit.exitCode,0);assert.equal(exit.signal,null);assert.equal(exit.code,'HTTPD_CHILD_STOPPED');
 const final=await f.state();assert.equal(final.lastChildExit.operationId,exit.operationId);assert.equal(final.lastLauncherExit.result,'success');
 const processExit=await f.waitLog(e=>e.stage==='process.exit'&&e.pid===launcher.pid);assert.equal(processExit.exitCode,0);
 }finally{await f.close();}});

test('records signal receipt before graceful launcher shutdown',async()=>{const f=await fixture();try{
 const launcher=f.run('start');await f.wait(s=>s.healthyAt);await f.waitLog(e=>e.stage==='server.import'&&e.result==='success');
 const exited=once(launcher,'exit');process.kill(launcher.pid,'SIGTERM');assert.equal((await exited)[0],0);
 const signal=await f.waitLog(e=>e.stage==='process.signal'&&e.pid===launcher.pid);
 assert.equal(signal.signal,'SIGTERM');assert.equal((await f.state()).desiredState,'stopped');
 const exit=await f.waitLog(e=>e.stage==='process.exit'&&e.pid===launcher.pid);assert.equal(exit.signal,'SIGTERM');
 }finally{await f.close();}});

test('pins child lifecycle output to the launcher log directory across different working directories',async()=>{const f=await fixture();try{
 await writeFile(path.join(f.releases,'first/server/main.js'),`if(process.env.NESTOS_HTTPD_LOG_DIR!==process.env.NESTOS_HTTPD_TEST_ROOT)throw Object.assign(new Error('different lifecycle log directory'),{code:'EFIXTURE'});
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
 f.run('start');const state=await f.wait(s=>s.healthyAt);
 await f.waitLog(e=>e.stage==='server.import'&&e.pid===state.child.pid&&e.result==='success');
 assert.equal((await f.logs()).some(e=>e.stage==='server.import'&&e.result==='failure'),false);
 }finally{await f.close();}});

for(const [name,source,stage,code] of [
 ['import failure',"throw Object.assign(new Error('fixture startup failure'),{code:'EFIXTURE'});",'server.import','HTTPD_SERVER_IMPORT_FAILED'],
 ['uncaught exception',"setTimeout(()=>{throw Object.assign(new Error('fixture runtime failure'),{code:'EFIXTURE'});},100);setInterval(()=>{},1000);",'process.fatal','HTTPD_UNCAUGHT_EXCEPTION'],
 ['unhandled rejection',"setTimeout(()=>Promise.reject(Object.assign(new Error('fixture rejection'),{code:'EFIXTURE'})),100);setInterval(()=>{},1000);",'process.fatal','HTTPD_UNHANDLED_REJECTION'],
 ])test(`records ${name} without preventing process failure`,async()=>{const f=await fixture();try{
 await writeFile(path.join(f.releases,'first/server/main.js'),source);f.run('start');
 const fatal=await f.waitLog(e=>e.stage===stage&&e.role==='server'&&e.result==='failure');assert.equal(fatal.code,code);assert.equal(fatal.errorCode,'EFIXTURE');
 const exit=await f.waitLog(e=>e.stage==='child.exit'&&e.pid===fatal.pid);assert.equal(exit.exitCode,1);assert.equal(exit.result,'failure');
 assert.equal(exit.operationId,fatal.operationId);assert.ok(fatal.locations.length>0);
 }finally{await f.close();}});

test('recovery records an unobserved launcher disappearance without inventing a signal',async()=>{const f=await fixture();try{
 const launcher=f.run('start'),first=await f.wait(s=>s.healthyAt);await f.waitLog(e=>e.stage==='process.start'&&e.role==='server');
 const exited=once(launcher,'exit');process.kill(launcher.pid,'SIGKILL');await exited;
 f.run('start');await f.wait(s=>s.launcher.pid!==launcher.pid);
 const evidence=await f.waitLog(e=>e.stage==='launcher.previous-exit'&&e.pid===launcher.pid);
 assert.equal(evidence.result,'unknown');assert.equal(evidence.code,'HTTPD_LAUNCHER_EXIT_UNOBSERVED');assert.equal(evidence.signal,undefined);
 assert.equal(evidence.durationMs,undefined);assert.ok(evidence.elapsedSinceStartMs>=0);
 assert.equal((await f.state()).lastLauncherExit.operationId,evidence.operationId);assert.equal((await f.state()).child.pid,first.child.pid);
 }finally{await f.close();}});

test('server writes fatal receipts after launcher death and recovery marks missing evidence unknown',async()=>{const f=await fixture();try{
 await writeFile(path.join(f.releases,'first/server/main.js'),`import{existsSync}from'node:fs';
 process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{if(existsSync(process.env.NESTOS_HTTPD_TEST_ROOT+'/crash'))throw Object.assign(new Error('fixture orphan crash'),{code:'EFIXTURE'});},20);`);
 const launcher=f.run('start'),first=await f.wait(s=>s.healthyAt);await f.waitLog(e=>e.stage==='server.import'&&e.result==='success');
 const exited=once(launcher,'exit');process.kill(launcher.pid,'SIGKILL');await exited;
 await writeFile(path.join(f.root,'crash'),'yes');
 const fatal=await f.waitLog(e=>e.stage==='process.fatal'&&e.pid===first.child.pid);assert.equal(fatal.errorCode,'EFIXTURE');
 const exit=await f.waitLog(e=>e.stage==='process.exit'&&e.pid===first.child.pid);assert.equal(exit.exitCode,1);
 assert.equal((await f.logs()).some(e=>e.stage==='child.exit'&&e.pid===first.child.pid),false);
 await rm(path.join(f.root,'crash'));f.run('start');await f.wait(s=>s.child?.pid!==first.child.pid&&s.healthyAt);
 const evidence=(await f.state()).lastChildExit;assert.equal(evidence.code,'HTTPD_CHILD_EXIT_UNOBSERVED');
 assert.equal(evidence.result,'unknown');assert.equal(evidence.exitCode,undefined);assert.equal(evidence.signal,undefined);
 }finally{await f.close();}});

test('healthy startup and restart collect superseded releases and unreferenced library snapshots',async()=>{
 const f=await fixture(true);
 const version=day=>'2026010'+day+'T000000-12345678';
 const snapshots=path.join(f.root,'release/local-libraries/snapshots');
 const snapshot=i=>String(i).repeat(64);
 try {
  for(let i=1;i<=6;i++)await mkdir(path.join(snapshots,snapshot(i)),{recursive:true});
  for(let i=1;i<=4;i++){
   const dir=path.join(f.releases,version(i));
   await mkdir(path.join(dir,'server'),{recursive:true});
   await writeFile(path.join(dir,'release.json'),JSON.stringify({id:version(i),librarySnapshot:snapshot(i)}));
   await writeFile(path.join(dir,'server/main.js'),await readFile(path.join(f.releases,'first/server/main.js')));
  }
  await mkdir(path.join(f.releases,'.pending-acceptance'));
  await writeFile(path.join(f.releases,'.pending-acceptance',version(2)),'');
  await writeFile(path.join(snapshots,'../prepared.json'),JSON.stringify({format:1,id:snapshot(5)}));
  await writeFile(path.join(snapshots,'../active.json'),JSON.stringify({format:1,mode:'snapshot',id:snapshot(6)}));
  await writeFile(path.join(f.releases,'current.json'),JSON.stringify({id:version(3)}));
  f.run('start');await f.waitLog(e=>e.stage==='launcher.cleanup'&&e.result==='success');
  assert.deepEqual((await readdir(snapshots)).sort(),[2,3,4,5,6].map(snapshot));
  const releases=async()=>(await readdir(f.releases)).filter(id=>id.startsWith('2026')).sort();
  assert.deepEqual(await releases(),[2,3,4].map(version));
  const bad=f.run('switch',['bad','--operation-id','failed']);
  assert.notEqual((await once(bad,'exit'))[0],0);
  assert.deepEqual(await releases(),[2,3,4].map(version));
  await writeFile(path.join(f.releases,'current.json'),JSON.stringify({id:version(4)}));
  const restart=f.run('restart',['--operation-id','healthy-restart']);
  assert.equal((await once(restart,'exit'))[0],0);
  await f.waitLog(e=>e.stage==='launcher.cleanup'&&e.operationId==='healthy-restart'&&e.result==='success');
  assert.deepEqual(await releases(),[2,4].map(version));
  assert.deepEqual((await readdir(snapshots)).sort(),[2,4,5,6].map(snapshot));
 }finally{await f.close();}
});

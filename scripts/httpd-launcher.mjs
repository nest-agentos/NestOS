import {spawn} from 'node:child_process';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostArguments,hostEnvironment,runtimePaths,runtimeLog,releaseDirectory,verifyRelease} from './httpd-runtime.mjs';
import {processIdentity,runningHttpd,registerHttpd,unregisterHttpd,stopHttpd,lifecycleLog} from './httpd-process.mjs';
import {readLaunch,changeLaunch,launcherAlive,requestLaunch,waitLaunch,pause,launchFailure} from './httpd-launch-state.mjs';
import {launchHealth} from './httpd-launch-health.mjs';
const childEntry=fileURLToPath(new URL('./httpd-child.mjs',import.meta.url));
const terminal=new Set(['succeeded','rolled-back','failed']);
async function selected(releases){return JSON.parse(await readFile(path.join(releases,'current.json'),'utf8')).id;}
async function select(releases,id){const file=path.join(releases,'.current-'+randomUUID());await writeFile(file,JSON.stringify({id})+'\n',{mode:0o600});await rename(file,path.join(releases,'current.json'));}
async function updateOperation(root,id,change){return changeLaunch(root,'release',state=>state.operation?.id===id?{...state,operation:{...state.operation,...change}}:state);}
async function finish(root,id,result,code){return changeLaunch(root,'release',state=>{
    if(state.operation?.id!==id)return state;
    const operation={...state.operation,phase:result==='success'?'succeeded':code==='HTTPD_SWITCH_ROLLED_BACK'?'rolled-back':'failed'};
    const receipt={operationId:id,fingerprint:operation.fingerprint,result,code,version:state.currentRelease,finishedAt:Date.now()};
    lifecycleLog({operationId:id,stage:'launcher.operation',result,code,version:state.currentRelease,durationMs:Date.now()-operation.createdAt});
    return {...state,operation,receipts:{...state.receipts,[id]:receipt}};
});}
async function alive(record){return !!record&&(await processIdentity(record.pid,false))?.birth===record.birth;}
async function stopChild(root,releases){
    const state=await readLaunch(root,'release');if(!state.child)return;
    try{await stopHttpd(root,'release',releases,{owned:state.child,timeoutMs:15000});}
    catch(error){if(error.code!=='HTTPD_SAFE_STOP_PENDING')throw error;while(await alive(state.child))await pause(200);}
    await unregisterHttpd(root,'release',state.child);
    await changeLaunch(root,'release',current=>current.child?.birth===state.child.birth?{...current,child:undefined}:current);
}
async function startChild(root,releases,id,args){
    const directory=releaseDirectory(releases,id);verifyRelease(directory);const entry=path.join(directory,'server/main.js');
    const file=runtimePaths('release').runtime,output=runtimeLog(file),banner=`HTTP mode: release\nVersion: ${id}\nRuntime log: ${file}\n`;
    console.log(banner);output.write(Buffer.from(banner));
    const child=spawn(process.execPath,[childEntry,entry,...hostArguments('release',args)],{cwd:directory,detached:true,stdio:['inherit','pipe','pipe','ipc'],env:{...hostEnvironment(),NESTOS_HTTPD_SERVICE_ID:(await readLaunch(root,'release')).serviceId,INIT_CWD:root,NESTOS_HTTPD_MODE:'release',NESTOS_HTTPD_VERSION:id}});
    child.stdout.on('data',chunk=>{output.write(chunk);process.stdout.write(chunk);});child.stderr.on('data',chunk=>{output.write(chunk);process.stderr.write(chunk);});
    child.once('error',error=>lifecycleLog({stage:'launcher.spawn',result:'failure',code:error.code??'HTTPD_SPAWN_FAILED'}));child.once('close',()=>output.close());
    try{const record=await registerHttpd(root,'release',child.pid,entry,args);
        await changeLaunch(root,'release',state=>({...state,child:record,childRelease:id,healthyAt:undefined}));child.send('start');return record;
    }catch(error){child.kill('SIGTERM');throw error;}
}
async function healthy(root,id,probe,timeoutMs){
    const deadline=Date.now()+timeoutMs;
    do{const state=await readLaunch(root,'release');if(state.desiredState==='stopped'||!await alive(state.child))return false;
        if(await probe(id))return true;await pause(300);
    }while(Date.now()<deadline);return false;
}
async function switchRelease(root,releases,operation,probe,timeoutMs){
    let state=await readLaunch(root,'release');const rollback=operation.phase==='rollback';
    const target=rollback?operation.previous:operation.target;verifyRelease(releaseDirectory(releases,target));
    if(['queued','stopping'].includes(operation.phase)||state.childRelease!==target||!await alive(state.child)){
        await updateOperation(root,operation.id,{phase:rollback?'rollback':'stopping'});await stopChild(root,releases);
        state=await readLaunch(root,'release');if(state.desiredState==='stopped'||state.operation.id!==operation.id)return;
        await updateOperation(root,operation.id,{phase:rollback?'rollback':'checking'});await startChild(root,releases,target,state.args);
    }
    if(await healthy(root,target,probe,timeoutMs)){
        state=await readLaunch(root,'release');if(state.desiredState==='stopped'||state.operation.id!==operation.id)return;
        await select(releases,target);await changeLaunch(root,'release',old=>({...old,currentRelease:target,restarts:0}));
        await finish(root,operation.id,rollback?'failure':'success',rollback?'HTTPD_SWITCH_ROLLED_BACK':undefined);return;
    }
    if((await readLaunch(root,'release')).desiredState==='stopped')return;
    if(!rollback&&operation.previous&&operation.previous!==target){await updateOperation(root,operation.id,{phase:'rollback'});return;}
    await stopChild(root,releases);await changeLaunch(root,'release',old=>({...old,desiredState:'stopped'}));await finish(root,operation.id,'failure','HTTPD_HEALTH_FAILED');
}
export async function runLauncher(root,releases,args){
    const identity=await processIdentity(process.pid,false);
    await changeLaunch(root,'release',async old=>{
        if(await launcherAlive(old))throw launchFailure('HTTPD_ALREADY_RUNNING');
        const hosts=await runningHttpd(root,'release',releases);if(hosts.some(host=>host.birth!==old?.child?.birth))throw launchFailure('HTTPD_ALREADY_RUNNING');
        const fresh=old?.desiredState!=='running'&&(!old?.operation||terminal.has(old.operation.phase));
        if(fresh&&old?.restarts)lifecycleLog({operationId:randomUUID(),stage:'launcher.retry.reset',result:'success',previousRestarts:old.restarts,durationMs:0});
        return {...old,schema:1,root:path.resolve(root),mode:'release',serviceId:old?.serviceId??'httpd-'+randomUUID(),args:old?.operation&&!terminal.has(old.operation.phase)?old.args:args,
            desiredState:old?.operation&&!terminal.has(old.operation.phase)?old.desiredState:'running',currentRelease:old?.desiredState==='running'?old.currentRelease:await selected(releases),launcher:identity,receipts:old?.receipts??{},restarts:fresh?0:old?.restarts??0,healthyAt:fresh?undefined:old?.healthyAt};
    });
    const probe=launchHealth(root,(await readLaunch(root,'release')).args,'release');
    const stop=()=>{void changeLaunch(root,'release',old=>({...old,desiredState:'stopped'})).catch(error=>lifecycleLog({stage:'launcher.stop',result:'failure',code:error.code}));};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);
    try{await loop(root,releases,probe);}finally{process.off('SIGTERM',stop);process.off('SIGINT',stop);await changeLaunch(root,'release',old=>old.launcher?.birth===identity.birth?{...old,launcher:undefined}:old);}
}
async function loop(root,releases,probe){
    while(true){
        const state=await readLaunch(root,'release');
        if(state.desiredState==='stopped'){await stopChild(root,releases);if(state.operation?.action==='stop')await finish(root,state.operation.id,'success');return;}
        if(state.operation&&!terminal.has(state.operation.phase)){try{await switchRelease(root,releases,state.operation,probe,probe.timeoutMs??120000);}catch(error){const current=await readLaunch(root,'release');if(state.operation.previous&&state.operation.phase!=='rollback'&&(!await alive(current.child)||current.childRelease!==state.operation.previous))await updateOperation(root,state.operation.id,{phase:'rollback',code:error.code??'HTTPD_SWITCH_FAILED'});else await finish(root,state.operation.id,'failure',error.code??'HTTPD_SWITCH_FAILED');}continue;}
        if(!await alive(state.child)){
            if(state.child)await unregisterHttpd(root,'release',state.child);
            if(state.restarts>=3){await changeLaunch(root,'release',old=>({...old,desiredState:'stopped'}));throw Object.assign(launchFailure('HTTPD_RESTART_LIMIT'),{message:'HTTPD_RESTART_LIMIT: Three automatic startup attempts failed. Inspect the runtime log, fix the startup error, then run pnpm httpd again.'});}
            if(state.restarts)await pause(Math.min(8000,1000*2**state.restarts));
            await changeLaunch(root,'release',old=>({...old,restarts:old.restarts+1}));await startChild(root,releases,state.currentRelease,state.args);
            const good=await healthy(root,state.currentRelease,probe,probe.timeoutMs??120000);if(!good){await stopChild(root,releases);continue;}
            await changeLaunch(root,'release',old=>({...old,healthyAt:Date.now()}));
        }else if(state.healthyAt&&Date.now()-state.healthyAt>30000&&state.restarts)await changeLaunch(root,'release',old=>({...old,restarts:0}));
        await pause(200);
    }
}
export async function launcherCommand(root,releases,command,args){
    const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
    const state=await readLaunch(root,'release');
    if(command==='status'){console.log(JSON.stringify({serviceId:state?.serviceId,launcherRunning:await launcherAlive(state),desiredState:state?.desiredState,currentRelease:state?.currentRelease,child:state?.child?.pid,operation:state?.operation,receipt:state?.receipts?.[state?.operation?.id]}));return;}
    if(command==='start')return runLauncher(root,releases,args);
    const timeoutMs=Number(value('--timeout-ms')??(command==='stop'?15000:90000));if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0||timeoutMs>300000)throw launchFailure('HTTPD_INVALID_STOP_TIMEOUT');
    if(!await launcherAlive(state)){
        if(command==='switch')throw launchFailure('HTTPD_LAUNCHER_NOT_RUNNING');
        if(command==='restart'&&state?.operation&&!terminal.has(state.operation.phase))return runLauncher(root,releases,state.args);
        const hosts=await runningHttpd(root,'release',releases),previous=hosts[0];
        if(command==='restart'&&previous){
            const previousId=path.relative(releases,previous.entry).split(path.sep)[0],target=await selected(releases);
            await changeLaunch(root,'release',old=>({...old,schema:1,root:path.resolve(root),mode:'release',serviceId:old?.serviceId??'httpd-'+randomUUID(),args:previous.args,desiredState:'running',currentRelease:previousId,receipts:old?.receipts??{},restarts:0}));
            const seeded=await readLaunch(root,'release');await requestLaunch(root,'release',{operationId:randomUUID(),action:'switch',targetRelease:target,expectedCurrent:previousId,serviceId:seeded.serviceId});
        }
        if(command==='stop'&&state){
            const operationId=value('--operation-id')??randomUUID();
            await requestLaunch(root,'release',{operationId,action:'stop',serviceId:state.serviceId});
            await stopHttpd(root,'release',releases,{timeoutMs,force:args.includes('--force')});
            await finish(root,operationId,'success');return;
        }
        await stopHttpd(root,'release',releases,{timeoutMs,force:args.includes('--force')});
        if(command==='restart')return runLauncher(root,releases,previous?.args??[]);return;
    }
    if(command!=='stop')launchHealth(root,state.args,'release');
    const target=command==='stop'?undefined:command==='switch'?args[0]:await selected(releases);if(target)verifyRelease(releaseDirectory(releases,target));
    const operationId=value('--operation-id')??randomUUID();if(!/^[\w-]{1,128}$/.test(operationId))throw launchFailure('HTTPD_OPERATION_INVALID');
    await requestLaunch(root,'release',{operationId,action:command==='stop'?'stop':'switch',targetRelease:target,expectedCurrent:value('--expected-current')??state.currentRelease,serviceId:value('--service-id')??state.serviceId});
    if(args.includes('--force'))await stopHttpd(root,'release',releases,{timeoutMs,force:true});
    await waitLaunch(root,'release',operationId,timeoutMs);
}

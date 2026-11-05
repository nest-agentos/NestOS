import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {withHttpdControl,processIdentity} from './httpd-process.mjs';
export const launchFailure=code=>Object.assign(new Error(code),{code});
export const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function launchFile(root,mode) {
    const base=process.env.NESTOS_HTTPD_CONTROL_DIR||path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'nestos','httpd-launchers');
    return path.join(base,createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,24),mode+'.json');
}
export async function readLaunch(root,mode) {
    try{const text=await readFile(launchFile(root,mode),'utf8');if(text.length>1048576)throw launchFailure('HTTPD_LAUNCH_STATE_INVALID');
        const state=JSON.parse(text);if(state.schema!==1||state.root!==path.resolve(root)||state.mode!==mode||!['running','stopped'].includes(state.desiredState)||typeof state.serviceId!=='string'||!Array.isArray(state.args)||state.args.some(arg=>typeof arg!=='string'))throw launchFailure('HTTPD_LAUNCH_STATE_INVALID');return state;
    }catch(error){if(error.code==='ENOENT')return undefined;throw error;}
}
export async function changeLaunch(root,mode,change) {
    return withHttpdControl(root,async()=>{
        const old=await readLaunch(root,mode),state=await change(old);if(!state)return old;
        const file=launchFile(root,mode);await mkdir(path.dirname(file),{recursive:true,mode:0o700});
        const temporary=file+'.'+randomUUID();await writeFile(temporary,JSON.stringify(state)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,file);return state;
    });
}
export async function launcherAlive(state) {return !!state?.launcher&& (await processIdentity(state.launcher.pid,false))?.birth===state.launcher.birth;}
export async function requestLaunch(root,mode,request) {
    return changeLaunch(root,mode,state=>{
        if(!state)throw launchFailure('HTTPD_LAUNCHER_NOT_RUNNING');
        if(request.serviceId&&request.serviceId!==state.serviceId)throw launchFailure('HTTPD_SERVICE_MISMATCH');
        const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex'),prior=state.receipts?.[request.operationId];
        if(prior){if(prior.fingerprint!==fingerprint)throw launchFailure('HTTPD_OPERATION_CONFLICT');return state;}
        if(state.operation?.id===request.operationId){if(state.operation.fingerprint!==fingerprint)throw launchFailure('HTTPD_OPERATION_CONFLICT');return state;}
        if(state.operation&&!state.receipts?.[state.operation.id]&&request.action!=='stop')throw launchFailure('HTTPD_SWITCH_PENDING');
        const receipts={...state.receipts};if(request.action==='stop'&&state.operation&&!receipts[state.operation.id])receipts[state.operation.id]={operationId:state.operation.id,fingerprint:state.operation.fingerprint,result:'failure',code:'HTTPD_SWITCH_CANCELLED'};
        if(request.action==='switch'&&request.expectedCurrent!==state.currentRelease)throw launchFailure('HTTPD_VERSION_CHANGED');
        if(Object.keys(state.receipts??{}).length>=512)throw launchFailure('HTTPD_OPERATION_HISTORY_LIMIT');
        return {...state,receipts,desiredState:request.action==='stop'?'stopped':'running',operation:{id:request.operationId,fingerprint,action:request.action,target:request.targetRelease,previous:state.currentRelease,phase:'queued',createdAt:Date.now()}};
    });
}
export async function waitLaunch(root,mode,id,timeoutMs) {
    const deadline=Date.now()+timeoutMs;
    do{const state=await readLaunch(root,mode),receipt=state?.receipts?.[id];if(receipt){if(receipt.result!=='success')throw launchFailure(receipt.code||'HTTPD_SWITCH_FAILED');if(state.operation?.action!=='stop'||!await launcherAlive(state))return receipt;}
        if(!await launcherAlive(state))throw launchFailure('HTTPD_LAUNCHER_EXITED');await pause(100);
    }while(Date.now()<deadline);
    throw launchFailure('HTTPD_SAFE_STOP_PENDING');
}

import type {RuntimeServiceControl} from '@nestos/app-core';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
/** Only the administrator runtime receives this local capability; no credential enters model context. */
export function localServiceControl():RuntimeServiceControl|undefined {
    const serviceId=process.env.NESTOS_HTTPD_SERVICE_ID,root=process.env.INIT_CWD;if(!serviceId||!root||!path.isAbsolute(root))return;
    const load=async()=>{
        const state=await import(pathToFileURL(path.join(root,'scripts/httpd-launch-state.mjs')).href);
        const runtime=await import(pathToFileURL(path.join(root,'scripts/httpd-runtime.mjs')).href);
        return {state,runtime};
    };
    const check=async()=>{const {state}=await load(),value=await state.readLaunch(root,'release');
        if(value?.serviceId!==serviceId||!await state.launcherAlive(value))throw Object.assign(new Error('Service controller unavailable'),{code:'SERVICE_CONTROLLER_UNAVAILABLE'});return value;};
    return {describe:async()=>{const value=await check();return {id:serviceId,version:value.currentRelease};},
        submit:async request=>{
            if(request.serviceId!==serviceId)throw Object.assign(new Error('Wrong service'),{code:'HTTPD_SERVICE_MISMATCH'});
            const {state,runtime}=await load();await check();runtime.verifyRelease(runtime.releaseDirectory(runtime.releasesRoot(root),request.targetVersion));
            await state.requestLaunch(root,'release',{operationId:request.operationId,action:'switch',targetRelease:request.targetVersion,expectedCurrent:request.expectedVersion,serviceId});
        },inspect:async request=>{
            const value=await check(),receipt=value.receipts?.[request.operationId];if(!receipt)return {state:'running'};
            if(receipt.result!=='success')return {state:'failed',code:receipt.code??'SERVICE_REPLACEMENT_FAILED'};
            return value.currentRelease===request.targetVersion?{state:'succeeded',version:request.targetVersion}:{state:'failed',code:'SERVICE_VERSION_MISMATCH'};
        }};
}

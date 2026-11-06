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
    return {describe:async()=>{const value=await check();const {runtime}=await load(),relative=path.relative(root,runtime.releasesRoot(root));
            return {id:serviceId,version:process.env.NESTOS_HTTPD_VERSION??value.currentRelease,artifact:{format:'nestos.httpd.release/1',manifest:'release.json',...(!path.isAbsolute(relative)&&!relative.startsWith('..')?{store:{base:'source-checkout' as const,path:relative.split(path.sep).join('/')}}:{})}};},
        provenance:async()=>{
            await check();const {runtime}=await load(),version=process.env.NESTOS_HTTPD_VERSION;if(!version)return;
            const manifest=runtime.verifyRelease(runtime.releaseDirectory(runtime.releasesRoot(root),version));
            if(manifest.id!==version||manifest.dirty!==false||typeof manifest.commit!=='string'||!/^[a-f0-9]{40,64}$/.test(manifest.commit))return;
            return {serviceId,version,sourceCommit:manifest.commit};
        },
        submit:async request=>{
            if(request.serviceId!==serviceId)throw Object.assign(new Error('Wrong service'),{code:'HTTPD_SERVICE_MISMATCH'});
            const {state,runtime}=await load();await check();const started=Date.now();
            try{runtime.verifyRelease(runtime.releaseDirectory(runtime.releasesRoot(root),request.targetVersion));}
            catch(error){console.warn('[HTTPServiceControl]',JSON.stringify({operation:'service.replace',operationId:request.operationId,stage:'artifact.verify',result:'failure',code:'SERVICE_ARTIFACT_INVALID',causeCode:(error as {code?:string}).code,durationMs:Date.now()-started}));
                throw Object.assign(new Error('Candidate does not match the declared service artifact'),{code:'SERVICE_ARTIFACT_INVALID',executionOutcome:'not-started',retryable:false});}
            await state.requestLaunch(root,'release',{operationId:request.operationId,action:'switch',targetRelease:request.targetVersion,expectedCurrent:request.expectedVersion,serviceId});
        },inspect:async request=>{
            const value=await check(),receipt=value.receipts?.[request.operationId];if(!receipt)return {state:'running'};
            if(receipt.result!=='success')return {state:'failed',code:receipt.code??'SERVICE_REPLACEMENT_FAILED'};
            return value.currentRelease===request.targetVersion?{state:'succeeded',version:request.targetVersion}:{state:'failed',code:'SERVICE_VERSION_MISMATCH'};
        }};
}

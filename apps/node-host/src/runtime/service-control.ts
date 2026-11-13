import {releaseDependencies} from './release-provenance';
import type {RuntimeServiceControl} from '@nestos/app-core';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openSync,fstatSync,readFileSync,closeSync,constants} from 'node:fs';
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
        verifyArtifact:async request=>{
            const started=Date.now();
            try{if(request.serviceId!==serviceId)throw Object.assign(new Error('Wrong service'),{code:'HTTPD_SERVICE_MISMATCH'});
                await check();const {runtime}=await load(),directory=runtime.releaseDirectory(runtime.releasesRoot(root),request.version);
                runtime.verifyRelease(directory);verifyArtifactDigest(path.join(directory,'release.json'),request.sha256);
                console.info('[HTTPServiceControl]',JSON.stringify({operation:'artifact.verify',operationId:request.operationId,stage:'source-checkout',result:'success',durationMs:Date.now()-started}));
            }catch(error){console.warn('[HTTPServiceControl]',JSON.stringify({operation:'artifact.verify',operationId:request.operationId,stage:'source-checkout',result:'failure',code:(error as {code?:string}).code??'SERVICE_ARTIFACT_INVALID',durationMs:Date.now()-started}));throw error;}
        },
        provenance:async(previousVersion)=>{
            await check();const {runtime}=await load(),version=process.env.NESTOS_HTTPD_VERSION;if(!version)return;
            const manifest=runtime.verifyRelease(runtime.releaseDirectory(runtime.releasesRoot(root),version));
            if(manifest.id!==version||manifest.dirty!==false||typeof manifest.commit!=='string'||!/^[a-f0-9]{40,64}$/.test(manifest.commit))return;
            const current=runtime.releaseDirectory(runtime.releasesRoot(root),version),previous=runtime.releaseDirectory(runtime.releasesRoot(root),previousVersion);
            runtime.verifyRelease(previous);
            return {serviceId,version,sourceCommit:manifest.commit,dependencies:releaseDependencies(current,previous)};
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

/** Only the configured service store is reachable through this capability. */
function verifyArtifactDigest(file:string,digest:string):void {
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const before=fstatSync(fd);if(!before.isFile()||before.size<1||before.size>8*1024*1024)throw Object.assign(new Error('Artifact manifest size invalid'),{code:'OPERATION_RESULT_ARTIFACT_LIMIT'});
        const bytes=readFileSync(fd),after=fstatSync(fd);
        if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Object.assign(new Error('Artifact changed during verification'),{code:'ARTIFACT_READ_CONFLICT'});
        if(!/^[a-f0-9]{64}$/.test(digest)||createHash('sha256').update(bytes).digest('hex')!==digest)throw Object.assign(new Error('Artifact digest mismatch'),{code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
    }finally{closeSync(fd);}
}

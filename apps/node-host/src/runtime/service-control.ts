import {releaseDependencies} from './release-provenance';
import type {RuntimeServiceControl} from '@nestos/app-core';
import type {ServiceSwitchRequest} from '@nestos/app-contracts/services';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
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
            return {id:serviceId,version:process.env.NESTOS_HTTPD_VERSION??value.currentRelease,
                ...(relative==='release/httpd'?{build:{base:'source-checkout' as const,directory:'.',command:['node','scripts/httpd.mjs','build','--no-activate','--receipt']}}:{}),artifact:{format:'nestos.httpd.release/1',manifest:'release.json',...(!path.isAbsolute(relative)&&!relative.startsWith('..')?{store:{base:'source-checkout' as const,path:relative.split(path.sep).join('/')}}:{})}};},
        verifyArtifact:async request=>{
            const started=Date.now();
            try{if(request.serviceId!==serviceId)throw Object.assign(new Error('Wrong service'),{code:'HTTPD_SERVICE_MISMATCH'});
                await check();const {runtime}=await load(),directory=runtime.releaseDirectory(runtime.releasesRoot(root),request.version);
                const manifest=runtime.verifyRelease(directory);if(request.sourceVersion&&(manifest.commit!==request.sourceVersion||manifest.dirty!==false))throw Object.assign(new Error('Artifact source changed'),{code:'OPERATION_RESULT_SOURCE_CHANGED'});verifyArtifactDigest(path.join(directory,'release.json'),request.sha256);
                if(request.project)verifySourceCommit(root,request.sourceVersion);
                console.info('[HTTPServiceControl]',JSON.stringify({operation:'artifact.verify',operationId:request.operationId,stage:'source-checkout',result:'success',durationMs:Date.now()-started}));
            }catch(error){console.warn('[HTTPServiceControl]',JSON.stringify({operation:'artifact.verify',operationId:request.operationId,stage:'source-checkout',result:'failure',code:(error as {code?:string}).code??'SERVICE_ARTIFACT_INVALID',durationMs:Date.now()-started}));throw error;}
        },
        runningArtifact:async request=>{
            const version=process.env.NESTOS_HTTPD_VERSION;
            if(request.serviceId!==serviceId||!version)return;
            const current=await check();if(current.currentRelease!==version)return;
            const {runtime}=await load(),directory=runtime.releaseDirectory(runtime.releasesRoot(root),version);
            const manifest=runtime.verifyRelease(directory);
            if(manifest.id!==version||manifest.commit!==request.sourceVersion||manifest.dirty!==false)return;
            return {version,sha256:artifactDigest(path.join(directory,'release.json'))};
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
            const {launchHealth}=await import(pathToFileURL(path.join(root,'scripts/httpd-launch-health.mjs')).href);
            const result=await state.requestLaunch(root,'release',switchRequest(request),undefined,async (current:{args:string[]})=>
                process.env.NESTOS_HTTPD_VERSION===request.targetVersion&&await launchHealth(root,current.args,'release')(request.targetVersion));
            if(result.receipts?.[request.operationId]?.alreadyRunning)console.info('[HTTPServiceControl]',JSON.stringify({operation:'service.replace',operationId:request.operationId,stage:'reconcile-running',result:'success',version:request.targetVersion,durationMs:Date.now()-started}));
        },inspect:async request=>{
            const value=await check(),receipt=value.receipts?.[request.operationId];if(!receipt)return {state:'running'};
            const {state}=await load();
            if(receipt.fingerprint!==state.requestFingerprint(switchRequest(request)))return {state:'failed',code:'HTTPD_OPERATION_CONFLICT'};
            if(receipt.result!=='success')return {state:'failed',code:receipt.code??'SERVICE_REPLACEMENT_FAILED'};
            if(value.currentRelease!==request.targetVersion||receipt.version!==request.targetVersion)return {state:'failed',code:'SERVICE_VERSION_MISMATCH'};
            return process.env.NESTOS_HTTPD_VERSION===request.targetVersion?{state:'succeeded',version:request.targetVersion}:{state:'running'};
        }};
}

function switchRequest(request:ServiceSwitchRequest){
    return {operationId:request.operationId,action:'switch',targetRelease:request.targetVersion,expectedCurrent:request.expectedVersion,serviceId:request.serviceId};
}

function verifySourceCommit(root:string,commit:string|undefined):void {
    try {
        if(commit&&/^[a-f0-9]{40,64}$/.test(commit)&&execFileSync('git',['-C',root,'cat-file','-t',commit],
            {encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim()==='commit')return;
    }catch{/* Return a stable error code without Git diagnostics. */}
    throw Object.assign(new Error('Source commit unavailable in the trusted repository'),{code:'SERVICE_SOURCE_COMMIT_UNVERIFIED'});
}

/** Only the configured service store is reachable through this capability. */
function verifyArtifactDigest(file:string,digest:string):void {
    if(!/^[a-f0-9]{64}$/.test(digest)||artifactDigest(file)!==digest)throw Object.assign(new Error('Artifact digest mismatch'),{code:'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
}
function artifactDigest(file:string):string {
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const before=fstatSync(fd);if(!before.isFile()||before.size<1||before.size>8*1024*1024)throw Object.assign(new Error('Artifact manifest size invalid'),{code:'OPERATION_RESULT_ARTIFACT_LIMIT'});
        const bytes=readFileSync(fd),after=fstatSync(fd);
        if(bytes.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Object.assign(new Error('Artifact changed during verification'),{code:'ARTIFACT_READ_CONFLICT'});
        return createHash('sha256').update(bytes).digest('hex');
    }finally{closeSync(fd);}
}

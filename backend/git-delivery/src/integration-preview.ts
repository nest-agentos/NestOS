import {createModuleLogger} from '@nestos/common';
import type {GitProcess, GitSource} from './contracts';
import {simulateIntegration} from './integration-preview-script';

export type GitIntegrationPreview =
    | {state:'clean'; checkedSources:number}
    | {state:'conflicts'; checkedSources:number; paths:string[]; truncated:boolean}
    | {state:'unavailable'; code:string};

const log=createModuleLogger('git-delivery');
const oid=/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Preview committed and frozen changes-mode trees without touching a checkout, index or ref. */
export async function previewGitIntegration(process:GitProcess, operationId:string, target:string, sources:GitSource[]):Promise<GitIntegrationPreview> {
    const started=Date.now();
    let preview:GitIntegrationPreview;
    try {
        preview=await runPreview(process,target,sources);
    } catch {
        preview={state:'unavailable',code:'INTEGRATION_PREVIEW_PROCESS_FAILED'};
    }
    log[preview.state==='unavailable'?'warn':'info']('Git integration preview',{operationId,stage:'integration.preview',
        result:preview.state==='unavailable'?'failure':'success',outcome:preview.state,code:preview.state==='unavailable'?preview.code:undefined,
        count:sources.length,durationMs:Date.now()-started});
    return preview;
}

async function runPreview(process:GitProcess,target:string,sources:GitSource[]):Promise<GitIntegrationPreview> {
    if(!oid.test(target)||!sources.length||sources.some(source=>!validSource(source)))
        return {state:'unavailable',code:'INTEGRATION_PREVIEW_SOURCE_UNSUPPORTED'};
    const input=sources.map(({sourceHead,sourceTree})=>[sourceHead,sourceTree??null]);
    const result=await process.nativeShell.exec('python3',['-c',simulateIntegration,target,JSON.stringify(input)],{cwd:'/workspace',timeoutMs:30000});
    if(result.code!==0)return {state:'unavailable',code:'INTEGRATION_PREVIEW_GIT_FAILED'};
    return JSON.parse(result.stdout) as GitIntegrationPreview;
}

function validSource(source:GitSource):boolean {
    if(!source.sourceHead||!oid.test(source.sourceHead)||source.repositories?.some(repo=>repo.path!=='.'&&repo.dirty))return false;
    const dirty=source.repositories?.find(repo=>repo.path==='.')?.dirty;
    return dirty?typeof source.sourceTree==='string'&&oid.test(source.sourceTree):!source.sourceTree;
}

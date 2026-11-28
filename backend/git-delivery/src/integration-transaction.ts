import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {GitApproval, GitProcess, GitSource} from './contracts';
import {failure, requireValue} from './errors';
import {verifyGitIntegration} from './integration';
import {processWorkspacePath} from './worktree-paths';
import {gitWorkspace} from './worktree-modules';
import {inspectApprovedMergeScript} from './integration-merge-script';
import {integrationRecoveryScript} from './integration-publication-script';
import {dirtyIntegrationModules} from './integration-source-script';
import {integrationScript} from './integration-transaction-script';
import {parseCommitTrailers} from './commit-context';

export interface GitConflictResolution {path:string;choice:string;mode:'100644'|'100755'|'delete';oid?:string}
type GitChoice='source'|'target'|'retain-target'|Pick<GitConflictResolution,'mode'|'oid'>;
export interface GitIntegrationTransaction {
    operationId: string;
    previousTarget: string;
    targetBranch: string;
    sources: Array<GitSource & {commitContext?: {trailers?: string}}>;
    coordinationTaskId?: string;
    approval?: GitApproval;
    resolutions?:GitConflictResolution[];
}
const log = createModuleLogger('git-delivery');
const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const coordinationTrailer = 'NestOS-Coordination-Task';
function operationRef(input: GitIntegrationTransaction): string {
    return 'refs/nestos/integration/' + sha256HexSync(input.operationId);
}

export async function tryGitIntegration(process: GitProcess, input: GitIntegrationTransaction): Promise<'session' | 'applied'> {
    const choices=integrationChoices(input.approval,input.resolutions);
    if (!choices || !input.sources.length || input.sources.some(source => !source.sourceHead)) return 'session';
    if(input.sources.some(source=>dirtyIntegrationModules(source.repositories).length>0&&!source.sourceTree))return 'session';
    requireValue(objectId.test(input.previousTarget) && input.sources.every(source => objectId.test(source.sourceHead!)&&(!source.sourceTree||objectId.test(source.sourceTree))), 'OPERATION_GIT_IDENTITY_INVALID');
    const sources = await Promise.all(input.sources.map(async source => [
        await processWorkspacePath(process, source.directory), source.sourceHead!, source.repositories?.find(repo => repo.path === '.')?.dirty ? 'dirty' : 'clean',
        integrationTrailers(source,input.coordinationTaskId),source.sourceTree??'', JSON.stringify(dirtyIntegrationModules(source.repositories)),source.moduleTrailers??'',
        moduleMergeTrailers(source,input.coordinationTaskId),
    ]));
    const args = ['-c', integrationScript, 'nestos-integration', operationRef(input),
        input.previousTarget, 'refs/heads/' + input.targetBranch, JSON.stringify(choices), ...sources.flat()];
    const started = Date.now();
    const result = await process.nativeShell.exec('sh', args, {cwd: '/workspace', timeoutMs: 120000});
    const stage = result.stdout.trim().split('\n').at(-1);
    const code = stage && /^[A-Z_]{1,70}$/.test(stage) ? stage : 'INTEGRATION_OUTCOME_UNKNOWN';
    log.info('Git integration transaction', {operationId: input.operationId, stage: 'integration.apply',
        result: result.code === 0 ? 'success' : 'failure', code, durationMs: Date.now() - started});
    if (['INTEGRATION_MODULE_CAPTURE_FAILED','MERGE_PLAN_CONFLICTS_MISSING','INTEGRATION_APPROVED_BLOB_MISSING','INTEGRATION_RETAIN_TARGET_INVALID'].includes(code)) {
        throw Object.assign(failure(code), {executionOutcome:'not-started'});
    }
    if (result.code === 3 && input.resolutions && code !== 'INTEGRATION_PUBLICATION_UNKNOWN') {
        throw Object.assign(failure(code), {executionOutcome:'not-started'});
    }
    if (result.code === 3 && code !== 'INTEGRATION_PUBLICATION_UNKNOWN') return 'session';
    if (code === 'INTEGRATION_SOURCE_CHANGED' || code === 'INTEGRATION_TARGET_CHANGED') {
        throw Object.assign(failure(code), {executionOutcome: 'not-started'});
    }
    if (result.code !== 0) throw failure(code);
    return 'applied';
}

function integrationTrailers(source:GitIntegrationTransaction['sources'][number],coordinationTaskId?:string):string {
    const original=source.commitContext?.trailers??'',actual=parseCommitTrailers(original),additions:string[]=[];
    for(const [key,id] of [['NestOS-Task',source.taskId],[coordinationTrailer,coordinationTaskId]] as const){
        if(id===undefined)continue;
        requireValue(/^[A-Za-z0-9_-]{1,128}$/.test(id),'INTEGRATION_COORDINATION_ID_INVALID');
        requireValue(actual[key]===undefined||actual[key]===id,'INTEGRATION_COORDINATION_ID_MISMATCH');
        if(actual[key]===undefined)additions.push(key+': '+id);
    }
    return [original.trimEnd(),...additions].filter(Boolean).join('\n');
}

function moduleMergeTrailers(source:GitIntegrationTransaction['sources'][number],coordinationTaskId?:string):string{
    return source.taskId||coordinationTaskId?integrationTrailers(source,coordinationTaskId):'';
}

export async function resumeGitIntegration(process:GitProcess,input:GitIntegrationTransaction):Promise<string|undefined>{
    const done=await inspectGitIntegration(process,input);
    if(done)return done;
    const ref=operationRef(input);
    const checkpoint=await gitWorkspace(process,'/workspace',['rev-parse','--verify','--quiet',ref+'/base'],true);
    if(checkpoint.code===1){
        const legacy=await gitWorkspace(process,'/workspace',['rev-parse','--verify','--quiet',ref+'/original'],true);
        requireValue(legacy.code===1,'INTEGRATION_CHECKPOINT_INCOMPLETE');
        return;
    }
    requireValue(checkpoint.code===0&&checkpoint.stdout.trim()===input.previousTarget,'INTEGRATION_CHECKPOINT_INCOMPLETE');
    const candidate=(await gitWorkspace(process,'/workspace',['rev-parse','--verify',ref+'/candidate'])).stdout.trim();
    requireValue(objectId.test(candidate),'INTEGRATION_RECEIPT_INVALID');
    await verifyIntegrationSteps(process,input,candidate);
    const started=Date.now();
    const result=await process.nativeShell.exec('sh',['-c',integrationRecoveryScript,'nestos-integration-resume',ref,
        input.previousTarget,'refs/heads/'+input.targetBranch],{cwd:'/workspace',timeoutMs:120000});
    const code=result.stdout.trim().split('\n').at(-1);
    const safe=code&&/^[A-Z_]{1,70}$/.test(code)?code:'INTEGRATION_PUBLICATION_UNKNOWN';
    log.info('Git integration recovery',{operationId:input.operationId,stage:'integration.resume',result:result.code===0?'success':'failure',code:safe,durationMs:Date.now()-started});
    if(result.code!==0)throw Object.assign(failure(safe),{result:{integrationPaths:result.stdout.split('\n')
        .filter(line=>line.startsWith('INTEGRATION_PATH ')).map(line=>line.slice(17,529)).filter(Boolean).slice(0,16)}});
    return inspectGitIntegration(process,input);
}

export async function inspectGitIntegration(process: GitProcess, input: GitIntegrationTransaction): Promise<string | undefined> {
    const receipt = await gitWorkspace(process, '/workspace', ['rev-parse', '--verify', '--quiet', operationRef(input) + '/done'], true);
    if (receipt.code === 1) return;
    const target = receipt.stdout.trim();
    requireValue(receipt.code === 0 && objectId.test(target), 'INTEGRATION_RECEIPT_INVALID');
    const actual = (await gitWorkspace(process, '/workspace', ['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (await gitWorkspace(process, '/workspace', ['symbolic-ref', 'HEAD'])).stdout.trim();
    requireValue(branch === 'refs/heads/' + input.targetBranch &&
        (await gitWorkspace(process, '/workspace', ['merge-base', '--is-ancestor', target, actual], true)).code === 0, 'OPERATION_RESULT_TARGET_REWRITTEN');
    await verifyIntegrationSteps(process, input, target);
    return target;
}

async function verifyIntegrationSteps(process: GitProcess, input: GitIntegrationTransaction, target: string): Promise<void> {
    const ref = operationRef(input);
    const output = await gitWorkspace(process, '/workspace', ['for-each-ref', '--format=%(refname) %(objectname)', ref + '/steps', ref + '/sources']);
    const refs = new Map(output.stdout.trim().split('\n').map(line => line.split(' ') as [string, string]));
    requireValue(refs.size === input.sources.length * 2, 'INTEGRATION_RECEIPT_INVALID');
    let previousTarget = input.previousTarget;
    for (const [index, source] of input.sources.entries()) {
        const actualTarget = refs.get(ref + '/steps/' + index), captured = refs.get(ref + '/sources/' + index);
        requireValue(actualTarget && captured && objectId.test(actualTarget) && objectId.test(captured), 'INTEGRATION_RECEIPT_INVALID');
        if(actualTarget!==previousTarget&&(input.coordinationTaskId||source.taskId))await verifyTaskTrailers(process,actualTarget,source.taskId,input.coordinationTaskId);
        const repositories = await capturedRepositories(process,source,captured);
        await verifyCapturedTree(process, source, captured, previousTarget, actualTarget,input.approval,input.resolutions,moduleMergeTrailers(source,input.coordinationTaskId));
        await verifyGitIntegration(process, {...input, previousTarget, actualTarget, reportedTarget: actualTarget, sources: [{...source, repositories}]});
        previousTarget = actualTarget;
    }
    requireValue(previousTarget === target, 'INTEGRATION_RECEIPT_INVALID');
}

async function verifyTaskTrailers(process:GitProcess,head:string,taskId?:string,coordinationTaskId?:string):Promise<void> {
    const message=(await gitWorkspace(process,'/workspace',['show','-s','--format=%(trailers:only,unfold)',head])).stdout;
    const actual=parseCommitTrailers(message);
    requireValue((taskId===undefined||actual['NestOS-Task']===taskId)&&(coordinationTaskId===undefined||actual[coordinationTrailer]===coordinationTaskId),'INTEGRATION_COORDINATION_ID_MISMATCH');
}

async function capturedRepositories(process:GitProcess,source:GitSource,captured:string):Promise<GitSource['repositories']> {
    return source.repositories&&Promise.all(source.repositories.map(async repo=>{
        if(repo.path==='.')return {...repo,dirty:false};
        if(!repo.dirty)return repo;
        requireValue(source.sourceTree,'INTEGRATION_RECEIPT_INVALID');
        const entry=await gitWorkspace(process,'/workspace',['ls-tree',captured,'--',repo.path]);
        const head=/^160000 commit ([a-f0-9]{40,64})\t/.exec(entry.stdout)?.[1];
        requireValue(head,'INTEGRATION_RECEIPT_INVALID');
        const parent=await gitWorkspace(process,'/workspace/'+repo.path,['show','-s','--format=%P',head]);
        requireValue(parent.stdout.trim()===repo.head,'INTEGRATION_RECEIPT_INVALID');
        return {...repo,head,dirty:false};
    }));
}

async function verifyCapturedTree(process: GitProcess, source: GitSource, captured: string, previous: string, target: string,approval?:GitApproval,resolutions?:GitConflictResolution[],trailers=''): Promise<void> {
    const git = async (args: string[]) => (await gitWorkspace(process, '/workspace', args)).stdout.trim();
    if (source.repositories?.some(repo => repo.path === '.' && repo.dirty)) {
        requireValue(await git(['show', '-s', '--format=%P', captured]) === source.sourceHead, 'INTEGRATION_RECEIPT_INVALID');
        if(source.sourceTree)requireValue(await git(['rev-parse',captured+'^{tree}'])===source.sourceTree,'INTEGRATION_RECEIPT_INVALID');
    } else {
        requireValue(captured === source.sourceHead, 'INTEGRATION_RECEIPT_INVALID');
    }
    const actual = await git(['rev-parse', target + '^{tree}']);
    if(captured===previous){requireValue(actual===await git(['rev-parse',previous+'^{tree}']),'INTEGRATION_RECEIPT_INVALID');return;}
    const choices=integrationChoices(approval,resolutions);requireValue(choices,'INTEGRATION_RECEIPT_INVALID');
    const replay=await process.nativeShell.exec('sh',['-c',inspectApprovedMergeScript,'nestos-merge-proof',previous,captured,JSON.stringify(choices),JSON.stringify(dirtyIntegrationModules(source.repositories)),trailers],
        {cwd:'/workspace',timeoutMs:120000});
    requireValue(replay.code===0&&actual===replay.stdout.trim(),'INTEGRATION_RECEIPT_INVALID');
}


export function validateGitConflictResolutions(approval:GitApproval|undefined,value:unknown):GitConflictResolution[] {
    requireValue(Array.isArray(value)&&value.length<=100&&value.every(validResolution),'OPERATION_RESULT_INTEGRATION_PROPOSAL_INVALID');
    requireValue(integrationChoices(approval,value)!==undefined,'OPERATION_RESULT_INTEGRATION_PROPOSAL_INVALID');
    return value.map(({path,choice,mode,oid})=>({path,choice,mode,...(oid?{oid}:{})}));
}

function validResolution(value:unknown):value is GitConflictResolution {
    const row=value as GitConflictResolution|undefined;
    return !!row&&typeof row.path==='string'&&row.path.length<=4096&&typeof row.choice==='string'
        &&(row.mode==='delete'?row.oid===undefined:['100644','100755'].includes(row.mode)&&typeof row.oid==='string'&&objectId.test(row.oid))
        &&row.path.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&part.toLowerCase()!=='.git'&&!/[\x00-\x1f\x7f]/.test(part));
}

function integrationChoices(approval?:GitApproval,resolutions?:GitConflictResolution[]):Record<string,GitChoice>|undefined {
    const choices=new Map<string,GitChoice>();
    const supplied=new Map((resolutions??[]).map(row=>[row.path,row]));
    if(supplied.size!==(resolutions?.length??0))return;
    for(const conflict of approval?.plan?.conflicts??[]){
        const choice=approval?.selections?.[conflict.id];
        if(!choice||!conflict.options.some(option=>option.id===choice)||choices.has(conflict.path))return;
        if(choice==='source'||choice==='target'||choice==='retain-target'){choices.set(conflict.path,choice);continue;}
        const proposal=supplied.get(conflict.path);
        if(!proposal||proposal.choice!==choice)return;
        supplied.delete(conflict.path);
        choices.set(conflict.path,{mode:proposal.mode,...(proposal.oid?{oid:proposal.oid}:{})});
    }
    if(supplied.size)return;
    return Object.fromEntries(choices);
}

export {previewGitIntegration, type GitIntegrationPreview} from './integration-preview';

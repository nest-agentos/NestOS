import {createModuleLogger} from '@nestos/common';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {WorkMessageScope} from '@nestos/kanban/execution';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {PromptBundle} from '../run/prompt-bundle';
import {decisionProjectScope,requireDecisionProjectContext} from '../kanban/decision-project-scope';
import {requireValue} from '../kanban/validation';
import {planningSections} from './kanban-planning-sections';
import type {NativeWorkInput} from './kanban-native-workspace';

export interface NativeWorkChannel {
    channelId:string;projectId:string;directory:string;context?:unknown;instructions?:string;
    contextProjects?:Array<{projectId:string;revision:number}>;
}
type ChannelBinding={previousScopeId:string;previousSessionId:string;sessionId?:string};
export function workChannelScope(input:NativeWorkInput):WorkMessageScope {
    return {runId:input.item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??input.dispatch.planId,
        itemId:input.item.id,attemptId:input.dispatch.id};
}
export function scopedWorkContext(remote:ProjectRemoteMountService,input:NativeWorkInput,projectId:string) {
    const projectIds=(input.context as {projectIds?:string[]}|undefined)?.projectIds;
    const contextProjects=input.stage==='decision'&&projectIds?decisionProjectScope(remote,projectId,projectIds):undefined;
    const context=contextProjects?{...input.context as object,projectBindings:projectIds!.map((id,index)=>({id,cellProjectId:contextProjects[index].projectId}))}:input.context;
    return {contextProjects,context};
}
export async function openNativeWorkChannel(remote:Pick<ProjectRemoteMountService,'sessionChannel'>,record:NativeWorkChannel,
    identity:WorkMessageScope,task:unknown,prompts:PromptBundle,planning:string,binding?:ChannelBinding,extensions?:Record<string,unknown>):Promise<void> {
    requireValue(record.channelId===identity.attemptId,'SESSION_CHANNEL_SCOPE_REQUIRED');
    const receipt=await remote.sessionChannel(record.projectId,'open',{scopeId:record.channelId,cwd:record.directory,...binding,
        ...(record.contextProjects?{contextProjects:record.contextProjects}:{}),
        snapshot:{identity,task,instructions:record.instructions??'',planning,...planningSections(record.context),...extensions,
            ...Object.fromEntries(prompts.files.map(file=>[file.name,{content:file.content,sha256:file.sha256}]))}});
    if(record.contextProjects)requireDecisionProjectContext(receipt,record.contextProjects);
}

export async function recordWorkspacePublication(journal:KanbanAutomationJournal,id:string,digest:string):Promise<void> {
    await journal.update<{sha256:string}>('development-publication:'+id,old=>{
        requireValue(!old||old.sha256===digest,'PROMPT_MANIFEST_CHANGED');return old??{sha256:digest};
    });
}
/** Fence the exact previous execution while selecting the next native Session explicitly. */
export async function currentChannelBinding(remote:Pick<ProjectRemoteMountService,'sessionChannel'>,record:NativeWorkChannel,sessionId?:string) {
    const started=Date.now();
    let active:{scopeId?:unknown;execution?:{sessionId?:unknown}};
    try {active=await remote.sessionChannel(record.projectId,'current',{cwd:record.directory}) as typeof active;}
    catch(error){const detail=error as {code?:string;remoteCode?:string;outcome?:string};
        if((detail.remoteCode??detail.code)!=='CHANNEL_SCOPE_UNKNOWN'||detail.outcome==='unknown')throw error;
        createModuleLogger('kanban-channel').debug('Channel predecessor absent',{operation:'kanban.channel.prepare',operationId:record.channelId,
            stage:'predecessor.read',result:'success',projectId:record.projectId,hasNativeSession:!!sessionId,durationMs:Date.now()-started});
        return undefined;
    }
    if(active.scopeId===record.channelId)return undefined;
    requireValue(typeof active.scopeId==='string'&&typeof active.execution?.sessionId==='string','CHANNEL_EXECUTION_UNKNOWN');
    return {previousScopeId:active.scopeId,previousSessionId:active.execution.sessionId,...(sessionId?{sessionId}:{})};
}


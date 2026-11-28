import type {IAgentManagementService} from '@nestos/kernel-adapters/contracts';
import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {HarnessConnectionService} from '../projects/harness-connections';
import {requireValue} from '../kanban/validation';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/resource-catalog';
import {decisionHarnessProfile,decisionHarnessModel,freezeKanbanHarness,preferredHarness,readFrozenHarness,harnessRetryTarget,selectProjectHarness,recordHarnessPreparation,coordinationHarnessScope,type ReadHarnessDefault} from './kanban-harness-settings';
import {developmentStage} from './kanban-development-log';
import {publishManagedAgent} from '../configuration/managed-agent';

export type NativeWorkInput=Parameters<NonNullable<PersonalKanbanAutomationOptions['prepareWork']>>[0];
export interface NativeWorkspaceOptions {
    readHarnessDefault?:ReadHarnessDefault;
    fs:IFileSystem;agents:IAgentManagementService;connections:HarnessConnectionService;remote:ProjectRemoteMountService;
    projects:Pick<import('@nestos/app-contracts/services').ProjectService,'get'|'openWorkspace'>;
}

export async function resolveNativeWork(options:NativeWorkspaceOptions,journal:KanbanAutomationJournal,input:NativeWorkInput) {
    requireValue(input.target.kind==='agent','NATIVE_AGENT_REQUIRED');
    const id=input.dispatch.id,source=await developmentStage(id,'agent.resolve',async()=>options.agents.getAgentRevision?.(input.target.id,input.target.version));
    requireValue(source?.target.digest===input.target.digest&&source.definition.execution?.kind==='harness','NATIVE_AGENT_REQUIRED');
    const selected=input.item.externalRefs?.filter(ref=>ref.system===REMOTE_PROJECT_REFERENCE)??[];
    requireValue(input.stage==='decision'?selected.length>0:selected.length===1,'SINGLE_PROJECT_TASK_REQUIRED');
    const connectionId=source.definition.execution.connectionId;
    const row=await developmentStage(id,'connection.resolve',()=>options.connections.get(connectionId));
    const template=row?.connection;
    requireValue(template&&template.enabled!==false,'NATIVE_CONNECTION_REQUIRED');
    const primary=(input.context as {primaryProjectId?:string}|undefined)?.primaryProjectId;
    const projectId=input.stage==='decision'&&primary?primary:selected[0].id,role=input.stage==='decision'?'coordination':'execution';
    const retry=role==='coordination'?input.item.launch?.analysisPreparation:input.dispatch.continuation?.preparation;
    const explicit=harnessRetryTarget(retry,role)??decisionHarnessProfile(input.context,role);
    const manualModel=retry?undefined:decisionHarnessModel(input.context,role);
    const stored=await readFrozenHarness(journal,id,manualModel);
    const choice=stored??(explicit?{profileId:explicit,selection:manualModel}:await preferredHarness(role,input.board?.settings,options.readHarnessDefault));
    const {profileId,selection}=await freezeKanbanHarness(journal,id,input.board?.id??'legacy',role,choice??{profileId:template.profileId});
    const attempt=role==='coordination'?coordinationHarnessScope(input.board?.id??'legacy',input.item.id,input.item.launch?.analysisEpoch):id;
    const check=explicit!==undefined||selection!==undefined;
    const selectedProfile=check?await developmentStage(id,role+'.harness.select',()=>recordHarnessPreparation(journal,attempt,projectId,profileId,role,
        ()=>selectProjectHarness(options.remote,projectId,profileId,selection))):profileId;
    return {source,template,projectId,profileId:selectedProfile,selection,explicit:check,role};
}

export async function publishNativeWork(options:NativeWorkspaceOptions,journal:KanbanAutomationJournal,input:NativeWorkInput,
    workspace:Awaited<ReturnType<typeof resolveNativeWork>>,directory:string,systemPrompt:string) {
    const {template,projectId,profileId,selection,source:{definition}}=workspace;
    const root=options.remote.list(projectId).find(mount=>mount.at==='/');
    requireValue(root?.connectionId,'REMOTE_WORKSPACE_REQUIRED');
    const connection={...template,profileId,...(selection||profileId!==template.profileId?{selection}:{}),id:'work-'+input.dispatch.id,
        projectId,nodeConnectionId:root.connectionId,directory};
    const existing=await options.connections.get(connection.id);
    if(existing)requireValue(JSON.stringify(existing.connection)===JSON.stringify(connection),'WORK_CONNECTION_CHANGED');
    else await options.connections.save(connection,0);
    const target=await developmentStage(input.dispatch.id,'agent.publish',()=>publishManagedAgent(options.agents,journal,{
        ...definition,id:connection.id,name:input.item.title,
        memoryPolicy:{namespaceId:definition.memoryPolicy?.namespaceId??'agent',readScopes:[],writeScopes:[],retrievalLimit:0},
        config:{...definition.config,systemPromptId:undefined,systemPrompt},execution:{kind:'harness',connectionId:connection.id}}));
    await input.reportActivity?.({stage:'agent.prepared',result:'success',fields:{agentId:target.id}});
    return target;
}

export async function requireNativeWorkspaceHarness(options:Pick<NativeWorkspaceOptions,'remote'>,projectId:string,profileId:string):Promise<void> {
    const harness=await options.remote.projectHarness(projectId,{requireRegistered:true});
    try {
        const {profiles}=await harness.profiles();
        const capabilities=profiles.find(profile=>profile.id===profileId)?.capabilities;
        requireValue(capabilities,'KANBAN_HARNESS_UNAVAILABLE');
        requireValue(capabilities.workingDirectory,'NATIVE_WORKING_DIRECTORY_UNSUPPORTED');
        requireValue(capabilities.sessionChannels===true,'NATIVE_SESSION_CHANNEL_REQUIRED');
    }finally{await harness.close();}
}

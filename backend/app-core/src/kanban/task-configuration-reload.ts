import {reportHandoffFailure} from '@nestos/kanban-development';
import {sha256HexSync} from '@nestos/common';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import {kanbanTaskType,type KanbanClient,type KanbanItem} from '@nestos/kanban/contracts';
import {safeCode} from '@nestos/kanban/integration';
import {freezePrompts,publishPromptBundle,type PromptFile} from '../run/prompt-bundle';
import {resolveKanbanConfiguration} from '../presets/kanban-configuration-files';
import type {DevelopmentWorkspaceRecord} from '../presets/kanban-development';
import type {TaskRecoveryOptions} from './task-recovery-ports';
import {requireValue} from './validation';

type Reload=NonNullable<KanbanClient['reloadTaskConfiguration']>;
type Request=Parameters<Reload>[1];
interface ConfigurationReceipt {operationId:string;revision:string;configuration:string;previousRead?:string;read?:true}
interface Intent {boardId:string;itemId:string;sessionId:string;sourceId:string;resourceId:string;purpose?:Request['purpose'];revision?:string}

export function reloadTaskConfiguration(options:TaskRecoveryOptions):Reload {
    return async(boardId,request)=>{
        const started=Date.now(),{operationId}=request,event={operationId,boardId,stage:'task.configuration.reload'};
        try{
            requireValue(/^[A-Za-z0-9_-]{1,128}$/.test(operationId)&&(request.purpose===undefined||request.purpose==='report-handoff'),'INVALID_RECOVERY_REQUEST');
            const key='task-configuration-reload:'+operationId,prior=await options.journal.get<Intent>(key);
            if(prior)assertScope(prior,boardId,request);
            const revision=prior?.revision??await publishAndNotify(options,boardId,request,key,prior);
            options.log({...event,result:'success',durationMs:Date.now()-started});
            return {operationId,revision};
        }catch(error){
            options.log({...event,result:'failure',code:safeCode(error,'TASK_CONFIGURATION_RELOAD_FAILED'),durationMs:Date.now()-started});
            throw error;
        }
    };
}

async function publishAndNotify(options:TaskRecoveryOptions,boardId:string,request:Request,key:string,prior?:Intent):Promise<string>{
    const {item,archive}=await options.service.item(boardId,request.itemId);
    requireValue(!archive&&item.deletedAt===undefined&&item.control?.action!=='cancel','TASK_CONFIGURATION_WORKSPACE_UNAVAILABLE');
    const binding=await currentBinding(options.client(),boardId,item);
    requireValue(binding?.session.sessionId===request.sessionId&&binding.session.resourceId,'TASK_CONFIGURATION_SESSION_CHANGED');
    const {sourceId}=binding,resourceId=binding.session.resourceId;
    const intent=prior??await options.journal.update<Intent>(key,old=>old??{boardId,itemId:request.itemId,sessionId:request.sessionId,sourceId,resourceId,...(request.purpose?{purpose:request.purpose}:{})});
    assertScope(intent,boardId,request);
    requireValue(intent.sourceId===sourceId&&intent.resourceId===resourceId,'TASK_CONFIGURATION_SESSION_CHANGED');
    const record=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+sourceId);
    requireValue(record&&item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record.projectId)
        &&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??sourceId)),'TASK_CONFIGURATION_WORKSPACE_UNAVAILABLE');
    if(request.purpose==='report-handoff')requireValue(await reportHandoffFailure(options.journal,sourceId),'RECOVERY_TARGET_NOT_READY');
    const receipt=await publishConfiguration(options,record,request,key);
    const {revision}=receipt;
    const current=await currentBinding(options.client(),boardId,item);
    requireValue(current?.sourceId===sourceId&&current.session.sessionId===intent.sessionId&&current.session.resourceId===resourceId,
        'TASK_CONFIGURATION_SESSION_CHANGED');
    await notifySession(options,record,intent,request,revision);
    await options.journal.updateMany([
        {key,change:old=>({...old as Intent,revision})},
        {key:configurationKey(boardId,request.itemId,request.sessionId),change:value=>{
            const old=value as ConfigurationReceipt|undefined,previousRead=old?.read?old.configuration:old?.previousRead;
            return {...receipt,...(previousRead?{previousRead}:{})};
        }},
    ]);
    return revision;
}

async function currentBinding(client:KanbanClient,boardId:string,item:KanbanItem){
    if(kanbanTaskType(item)==='coordination'){
        const session=await client.planningSession?.(boardId,item.id);
        return session&&{session,sourceId:session.analysisId};
    }
    const detail=await client.executionSession?.(boardId,item.id);
    if(!detail?.current)return;
    const workflow=await client.workflow(boardId);
    const dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===item.id&&row.executionEpoch===item.executionEpoch)
        .sort((a,b)=>b.attempt-a.attempt)[0];
    if(dispatch?.executionSessionId===detail.current.sessionId)return {session:detail.current,sourceId:dispatch.id};
}

const relativeDirectory=(request:Request)=>'_nestos/kanban/config-reloads/'+request.operationId;
async function publishConfiguration(options:TaskRecoveryOptions,record:DevelopmentWorkspaceRecord,request:Request,key:string):Promise<ConfigurationReceipt>{
    const project=await options.projects.get(record.projectId);
    requireValue(options.projects.openWorkspace,'TASK_CONFIGURATION_WORKSPACE_UNAVAILABLE');
    const view=await options.projects.openWorkspace(project.path);
    try{
        const prompts=await freezePrompts(options.journal,key+':snapshot',()=>resolveKanbanConfiguration(options.fs,view.fs,record.policy.profile));
        const revision=await publishPromptBundle(view.fs,record.directory+'/'+relativeDirectory(request),prompts,
            {operationId:request.operationId,profile:record.policy.profile});
        return {revision,configuration:configurationDigest(prompts.files),operationId:request.operationId};
    }finally{await view.dispose();}
}

async function notifySession(options:TaskRecoveryOptions,record:DevelopmentWorkspaceRecord,intent:Intent,request:Request,revision:string):Promise<void>{
    const target=resolveBrowserTarget(intent.resourceId);
    requireValue(target.kind==='remote'&&target.profileId&&target.nativeSessionId,'CONTINUATION_NATIVE_SESSION_UNKNOWN');
    const port=await options.remote.projectConversation(record.projectId,target.profileId,target.nativeSessionId);
    const directory=relativeDirectory(request);
    try{
        requireValue(port.enqueue,'NATIVE_QUEUE_UNSUPPORTED');
        const action=request.purpose==='report-handoff'
            ?'Check the report directory against the effective limits. Move only confirmed task-owned temporary files outside the report directory. Preserve final reports, acceptance evidence and the original result. Reply with the outcome so the user can recheck delivery.'
            :'Apply the configuration to future work in this same Session.';
        await port.enqueue(`The host reloaded the effective Kanban configuration for this existing task. In the original task workspace, read ${directory}/manifest.json (revision ${revision}), then read the applicable files under ${directory}/prompts. Preserve the existing task, worktree and any submitted result. ${action} Do not publish a replacement result just to acknowledge this reload. After you have read the applicable configuration, include the exact standalone line CONFIGURATION_READ ${revision} in your reply.`,
            [],undefined,queueId(request.operationId),'next-turn');
    }finally{await port.close();}
}

function assertScope(intent:Intent,boardId:string,request:Request):void {
    requireValue(intent.boardId===boardId&&intent.itemId===request.itemId&&intent.sessionId===request.sessionId&&intent.purpose===request.purpose,'IDEMPOTENCY_CONFLICT');
}

const queueId=(operationId:string)=>'configuration-'+sha256HexSync(operationId);
const configurationKey=(board:string,item:string,session:string)=>'task-configuration-receipt:'+sha256HexSync(JSON.stringify([board,item,session]));
const configurationDigest=(files:PromptFile[])=>sha256HexSync(JSON.stringify(files.map(file=>[file.name,file.sha256]).sort()));

export async function taskConfigurationStatus(options:TaskRecoveryOptions,boardId:string,itemId:string):Promise<import('@nestos/kanban/contracts').KanbanTaskConfigurationStatus>{
    const {item}=await options.service.item(boardId,itemId);
    const binding=await currentBinding(options.client(),boardId,item);
    const record=binding&&await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+binding.sourceId);
    requireValue(record&&binding?.session.resourceId&&options.projects.openWorkspace&&item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record.projectId),
        'TASK_CONFIGURATION_WORKSPACE_UNAVAILABLE');
    const project=await options.projects.get(record.projectId),view=await options.projects.openWorkspace(project.path);
    let currentRevision:string;
    try{currentRevision=configurationDigest(await resolveKanbanConfiguration(options.fs,view.fs,record.policy.profile));}
    finally{await view.dispose();}
    const key=configurationKey(boardId,itemId,binding.session.sessionId),receipt=await options.journal.get<ConfigurationReceipt>(key);
    if(!receipt)return {currentRevision,state:'none'};
    const state=receipt.read?'read':await inspectConfigurationAcknowledgment(options,record,binding.session.resourceId,receipt);
    if(state==='read'&&!receipt.read)await options.journal.update<ConfigurationReceipt>(key,old=>old?.operationId===receipt.operationId?{...old,read:true}:old??receipt);
    const readRevision=state==='read'?receipt.configuration:receipt.previousRead;
    return {currentRevision,state,notifiedRevision:receipt.configuration,...(readRevision?{readRevision}:{})};
}

async function inspectConfigurationAcknowledgment(options:TaskRecoveryOptions,record:DevelopmentWorkspaceRecord,resourceId:string,receipt:ConfigurationReceipt){
    const target=resolveBrowserTarget(resourceId);
    requireValue(target.kind==='remote'&&target.profileId&&target.nativeSessionId,'CONTINUATION_NATIVE_SESSION_UNKNOWN');
    const port=await options.remote.projectConversation(record.projectId,target.profileId,target.nativeSessionId,undefined,true);
    try{
        const snapshot=await port.read(),submission=snapshot.instructionQueue?.submissions?.find(row=>row.id===queueId(receipt.operationId));
        if(!submission?.turnId)return 'queued' as const;
        return snapshot.messages.some(message=>message.role==='assistant'&&message.turnId===submission.turnId
            &&message.text.split(/\r?\n/).some(line=>line.trim()==='CONFIGURATION_READ '+receipt.revision))?'read' as const:'dispatched' as const;
    }finally{await port.close();}
}

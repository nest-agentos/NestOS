import {unavailableDecisionReference} from './decision-conversation-availability';
import {promptReferenceSections} from '../run/prompt-reference-sections';
import {selectKanbanHarness,freezeKanbanHarness,harnessSettingKey} from '../presets/kanban-harness-settings';
import {remoteSessionPath} from '@nestos/app-contracts';
import {conversationPolicy,conversationInstruction} from './conversation-policy';
import {randomUUID} from '@nestos/common';
import type {RecordConversationPort} from '@nestos/kanban/integration';
import type {DecisionConversationOptions,DecisionConversationBinding,DecisionConversation} from './decision-conversation-ports';
import {resolveKanbanConfiguration} from '../presets/kanban-configuration-files';
import {requireValue} from './validation';
import {REMOTE_PROJECT_REFERENCE,validateRemoteReferences} from './resource-catalog';
import type {KanbanExternalReference} from '@nestos/kanban/contracts';
import {diagnosticFailure} from '../diagnostics/failure';
import {decisionProjectScope,requireDecisionProjectContext} from './decision-project-scope';

export function decisionConversationTransport(options:DecisionConversationOptions,advance:RecordConversationPort['advance']):RecordConversationPort {
    return {referenceUnavailable:value=>unavailableDecisionReference(options,value as DecisionConversation),prepare:(id,board,resources,primary)=>prepare(options,id,board,resources,primary),start:(binding,first,active)=>start(options,binding as DecisionConversationBinding,first,active),advance,
        watch:async(value,wake)=>{const binding=value.binding as DecisionConversationBinding,client=await options.remote.projectHarness(binding.projectId);
            try {requireValue(client.subscribeChannel,'SESSION_CHANNEL_REQUIRED');const stop=client.subscribeChannel(binding.id,wake);return async()=>{stop();await client.close();};}
            catch(error){await client.close();throw error;}},close:async()=>{}};
}
async function prepare(options:DecisionConversationOptions,id:string,boardId:string,resources?:KanbanExternalReference[],primary?:KanbanExternalReference):Promise<DecisionConversationBinding> {
    requireValue(Array.isArray(resources)&&resources.length>0&&resources.length<=16&&resources.every(ref=>ref.system===REMOTE_PROJECT_REFERENCE)&&new Set(resources.map(ref=>ref.id)).size===resources.length,'DECISION_PROJECTS_REQUIRED');
    await validateRemoteReferences(options.projects,{externalRefs:resources});
    requireValue(primary?.system===REMOTE_PROJECT_REFERENCE&&resources.some(ref=>ref.id===primary.id),'DECISION_PRIMARY_PROJECT_REQUIRED');
    const contextProjects=decisionProjectScope(options.remote,primary.id,resources.map(ref=>ref.id));
    const projects=await Promise.all(resources.map(ref=>options.projects.get(ref.id)));
    const carrier=projects.find(row=>row.project?.id===primary.id)!,projectId=primary.id,client=await openHarness(options,projectId,id,boardId);
    try {
        const workspaceId=options.remote.list(projectId).find(row=>row.at==='/')?.serverProjectId;
        const coordination=await options.journal.get<{recordId:string}>('record-coordination-scope:'+id);
        const role=coordination?'coordination':'decision',board=await options.service.read(boardId),descriptor=await client.profiles();
        const old=await options.journal.get<{profileId:string}>('kanban-harness-choice:'+id);
        const selected=selectKanbanHarness(descriptor.profiles,workspaceId!,old?.profileId??board.settings?.[harnessSettingKey(role)]);
        const frozen=await freezeKanbanHarness(options.journal,id,boardId,role,selected.id);
        const profile=selectKanbanHarness(descriptor.profiles,workspaceId!,frozen);
        const record=coordination?await options.service.record(boardId,coordination.recordId):undefined;
        requireValue(!record||record.kind==='decision'&&record.status!=='draft','DECISION_NOT_CONFIRMED');
        const directory='_nestos/kanban/conversations/'+id,view=await options.projects.openWorkspace(carrier.path);
        try {
            const files=await resolveKanbanConfiguration(options.fs,view.fs,'development'),prompt=files.find(file=>file.name===(coordination?'coordination-conversation.md':'decision-propose.md'));requireValue(prompt,'KANBAN_PROFILE_FILE_MISSING');
            if(!await view.fs.driver.exists('/workspace/'+directory+'/.scope'))await view.fs.driver.createFile({parentPath:'/workspace/'+directory,name:'.scope',content:id,recursive:true});
            const receipt=await options.remote.sessionChannel(projectId,'open',{scopeId:id,cwd:directory,runId:id,itemId:id,attemptId:id,contextProjects,
                snapshot:{...promptReferenceSections(files,prompt.name),context:{boardId,...(coordination?{recordId:coordination.recordId}:{}),projects:projects.map(row=>({id:row.project!.id,name:row.displayName??row.name,cellProjectId:options.remote.list(row.project!.id).find(mount=>mount.at==='/')!.serverProjectId})),primaryProjectId:projectId,secondaryProjectIds:resources.filter(ref=>ref.id!==projectId).map(ref=>ref.id),conversationProjectId:projectId,projectIds:resources.map(ref=>ref.id),conversationId:id}}});
            requireDecisionProjectContext(receipt,contextProjects);
        }finally{await view.dispose();}
        return {id,boardId,...(coordination?{purpose:'coordination' as const,recordId:coordination.recordId}:{}),projectId,projectIds:resources.map(ref=>ref.id),profileId:profile.id,workspaceId:workspaceId!,directory,epoch:descriptor.epoch,createId:randomUUID(),inputId:randomUUID()};
    }finally{await client.close();}
}
async function start(options:DecisionConversationOptions,binding:DecisionConversationBinding,first:boolean,active:()=>boolean) {
    const key='decision-native:'+binding.id,client=await openHarness(options,binding.projectId,binding.id,binding.boardId);
    requireValue(active(),'SERVICE_STOPPING');
    let native=await options.journal.get<{sessionId:string}>(key);
    try {
        if(!native){
            let sessionId:string|undefined;
            if(first)sessionId=(await client.create(binding.profileId,binding.workspaceId,{directory:binding.directory,requestId:binding.createId,epoch:binding.epoch})).session.id;
            else {const receipt=await client.operation(binding.profileId,binding.createId,{epoch:binding.epoch});requireValue(receipt.outcome==='committed','DECISION_SESSION_OUTCOME_UNKNOWN');sessionId=(receipt.result as {session?:{id?:string}})?.session?.id;}
            requireValue(sessionId,'DECISION_SESSION_OUTCOME_UNKNOWN');native=await options.journal.update<{sessionId:string}>(key,old=>old??{sessionId});
        }
    }finally{await client.close();}
    requireValue(active(),'SERVICE_STOPPING');
    const conversation=await options.remote.projectConversation(binding.projectId,binding.profileId,native!.sessionId);
    try {requireValue(conversation.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await conversation.enqueue(binding.purpose==='coordination'?(await conversationPolicy(options.fs)).coordinationBootstrap:(await conversationPolicy(options.fs)).bootstrap,[],undefined,binding.inputId,'next-turn');}
    finally{await conversation.close();}
    const folder=await options.projects.get(binding.projectId);
    return {sessionId:native!.sessionId,resourceId:remoteSessionPath(folder.path,binding.profileId,native!.sessionId)};
}
async function openHarness(options:DecisionConversationOptions,projectId:string,operationId:string,boardId:string) {
    const started=Date.now();
    try{return await options.remote.projectHarness(projectId,{requireRegistered:true});}
    catch(error){
        const failure=diagnosticFailure(error);
        const code=failure.reason==='authorization-changed'?'DECISION_AUTHORIZATION_CHANGED':failure.code==='ECONFLICT'?'DECISION_PROJECT_BINDING_CHANGED':failure.code;
        options.log({operationId,boardId,stage:'decision.harness.open',result:'failure',code,durationMs:Date.now()-started});
        if(code!==failure.code)throw Object.assign(new Error(code,{cause:error}),{code});
        throw error;
    }
}
export async function resumeDecisionConversation(options:DecisionConversationOptions,value:DecisionConversation,requestId:string):Promise<void> {
    const conversation=await options.remote.projectConversation(value.binding.projectId,value.binding.profileId,value.sessionId);
    try{requireValue(conversation.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await conversation.enqueue(conversationInstruction((await conversationPolicy(options.fs)).resumeDecision,requestId),[],undefined,'reply-'+requestId,'next-turn');}
    finally{await conversation.close();}
}

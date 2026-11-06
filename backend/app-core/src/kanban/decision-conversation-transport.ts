import {remoteSessionPath} from '@nestos/app-contracts';
import {conversationPolicy,conversationInstruction} from './conversation-policy';
import {randomUUID} from '@nestos/common';
import type {RecordConversationPort} from '@nestos/kanban/integration';
import type {DecisionConversationOptions,DecisionConversationBinding,DecisionConversation} from './decision-conversation-ports';
import {resolveKanbanConfiguration} from '../presets/kanban-configuration-files';
import {requireValue} from './validation';

export function decisionConversationTransport(options:DecisionConversationOptions,advance:RecordConversationPort['advance']):RecordConversationPort {
    return {prepare:(id,board)=>prepare(options,id,board),start:(binding,first,active)=>start(options,binding as DecisionConversationBinding,first,active),advance,
        watch:async(value,wake)=>{const binding=value.binding as DecisionConversationBinding,client=await options.remote.projectHarness(binding.projectId);
            try {requireValue(client.subscribeChannel,'SESSION_CHANNEL_REQUIRED');const stop=client.subscribeChannel(binding.id,wake);return async()=>{stop();await client.close();};}
            catch(error){await client.close();throw error;}},close:async()=>{}};
}
async function prepare(options:DecisionConversationOptions,id:string,boardId:string):Promise<DecisionConversationBinding> {
    const projects=(await options.projects.list()).filter(row=>row.project?.source?.kind==='remote');requireValue(projects.length,'REMOTE_PROJECT_REQUIRED');
    const carrier=projects[0],projectId=carrier.project!.id,client=await options.remote.projectHarness(projectId,{requireRegistered:true});
    try {
        const descriptor=await client.profiles(),profile=descriptor.profiles.find(row=>row.projectRuntime&&row.capabilities.create&&row.capabilities.sessionChannels&&row.capabilities.workingDirectory&&row.workspaces.length);
        requireValue(profile,'NATIVE_SESSION_CHANNEL_REQUIRED');
        const directory='_nestos/kanban/conversations/'+id,view=await options.projects.openWorkspace(carrier.path);
        try {
            const files=await resolveKanbanConfiguration(options.fs,view.fs,'development'),prompt=files.find(file=>file.name==='decision-propose.md');requireValue(prompt,'KANBAN_PROFILE_FILE_MISSING');
            if(!await view.fs.driver.exists('/workspace/'+directory+'/.scope'))await view.fs.driver.createFile({parentPath:'/workspace/'+directory,name:'.scope',content:id,recursive:true});
            await options.remote.sessionChannel(projectId,'open',{scopeId:id,cwd:'/workspace/'+directory,runId:id,itemId:id,attemptId:id,
                snapshot:{'decision-propose.md':prompt.content,context:{boardId,projects:projects.map(row=>({id:row.project!.id,name:row.displayName??row.name})),conversationId:id}}});
        }finally{await view.dispose();}
        return {id,boardId,projectId,profileId:profile.id,workspaceId:profile.workspaces[0].id,directory,epoch:descriptor.epoch,createId:randomUUID(),inputId:randomUUID()};
    }finally{await client.close();}
}
async function start(options:DecisionConversationOptions,binding:DecisionConversationBinding,first:boolean,active:()=>boolean) {
    const key='decision-native:'+binding.id,client=await options.remote.projectHarness(binding.projectId,{requireRegistered:true});
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
    try {requireValue(conversation.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await conversation.enqueue((await conversationPolicy(options.fs)).bootstrap,[],undefined,binding.inputId,'next-turn');}
    finally{await conversation.close();}
    const folder=await options.projects.get(binding.projectId);
    return {sessionId:native!.sessionId,resourceId:remoteSessionPath(folder.path,binding.profileId,native!.sessionId)};
}
export async function resumeDecisionConversation(options:DecisionConversationOptions,value:DecisionConversation,requestId:string):Promise<void> {
    const conversation=await options.remote.projectConversation(value.binding.projectId,value.binding.profileId,value.sessionId);
    try{requireValue(conversation.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await conversation.enqueue(conversationInstruction((await conversationPolicy(options.fs)).resumeDecision,requestId),[],undefined,'reply-'+requestId,'next-turn');}
    finally{await conversation.close();}
}

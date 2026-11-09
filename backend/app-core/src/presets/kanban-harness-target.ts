import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {developmentPreparation} from './kanban-development';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {requireValue} from '../kanban/validation';
import {freezeKanbanHarness,harnessSettingKey,selectKanbanHarness} from './kanban-harness-settings';
import {publishManagedAgent} from '../configuration/managed-agent';
import {developmentStage} from './kanban-development-log';
type Options=Parameters<typeof developmentPreparation>[0];
/** Bind new direct Agent executions without changing the reusable Agent or connection. */
export function kanbanHarnessTarget(options:Options):NonNullable<PersonalKanbanAutomationOptions['prepareTarget']>{
    const journal=new KanbanAutomationJournal(options.fs,kanbanJournalOptions);
    return input=>developmentStage(input.dispatch.id,'harness.target',async()=>{
        const profileId=await freezeKanbanHarness(journal,input.dispatch.id,input.board.id,'execution',input.board.settings?.[harnessSettingKey('execution')]??'');
        if(!profileId)return input.target;
        requireValue(input.target.kind==='agent','NATIVE_AGENT_REQUIRED');
        const source=await options.agents.getAgentRevision?.(input.target.id,input.target.version);
        requireValue(source?.target.digest===input.target.digest&&source.definition.execution?.kind==='harness','NATIVE_AGENT_REQUIRED');
        const record=await options.connections.get(source.definition.execution.connectionId),template=record?.connection;
        requireValue(template&&template.enabled!==false,'NATIVE_CONNECTION_REQUIRED');
        const client=await options.remote.projectHarness(template.projectId,{requireRegistered:true});
        try{selectKanbanHarness((await client.profiles()).profiles,options.remote.list(template.projectId).find(row=>row.at==='/')!.serverProjectId!,profileId);}finally{await client.close();}
        const connection={...template,id:'kanban-'+input.dispatch.id,profileId,...(profileId!==template.profileId?{selection:undefined}:{})};
        const existing=await options.connections.get(connection.id);
        if(existing)requireValue(JSON.stringify(existing.connection)===JSON.stringify(connection),'WORK_CONNECTION_CHANGED');
        else await options.connections.save(connection,0);
        return publishManagedAgent(options.agents,journal,{...source.definition,id:connection.id,config:{...source.definition.config,systemPromptId:undefined,systemPrompt:[source.definition.config.systemPrompt,...source.systemPrompt?.content??[]].filter(Boolean).join('\n\n')},execution:{kind:'harness',connectionId:connection.id}});
    });
}

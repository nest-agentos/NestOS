import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {developmentPreparation} from './kanban-development';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {requireValue} from '../kanban/validation';
import {decisionHarnessProfile,decisionHarnessModel,freezeKanbanHarness,harnessSettingKey,harnessRetryTarget,selectProjectHarness,recordHarnessPreparation} from './kanban-harness-settings';
import {publishManagedAgent} from '../configuration/managed-agent';
import {developmentStage} from './kanban-development-log';
type Options=Parameters<typeof developmentPreparation>[0];
/** Bind new direct Agent executions without changing the reusable Agent or connection. */
export function kanbanHarnessTarget(options:Options):NonNullable<PersonalKanbanAutomationOptions['prepareTarget']>{
    const journal=new KanbanAutomationJournal(options.fs,kanbanJournalOptions);
    return input=>developmentStage(input.dispatch.id,'harness.target',async()=>{
        const retry=harnessRetryTarget(input.dispatch.continuation?.preparation,'execution');
        const explicit=retry??decisionHarnessProfile(input.context,'execution'),selection=retry?undefined:decisionHarnessModel(input.context,'execution');
        const frozen=await freezeKanbanHarness(journal,input.dispatch.id,input.board.id,'execution',explicit??input.board.settings?.[harnessSettingKey('execution')]??'');
        if(!frozen)return input.target;
        requireValue(input.target.kind==='agent','NATIVE_AGENT_REQUIRED');
        const source=await options.agents.getAgentRevision?.(input.target.id,input.target.version);
        requireValue(source?.target.digest===input.target.digest&&source.definition.execution?.kind==='harness','NATIVE_AGENT_REQUIRED');
        const record=await options.connections.get(source.definition.execution.connectionId),template=record?.connection;
        requireValue(template&&template.enabled!==false,'NATIVE_CONNECTION_REQUIRED');
        requireValue(!explicit||!input.projectId||template.projectId===input.projectId,'KANBAN_HARNESS_WORKSPACE_MISMATCH');
        const validate=()=>selectProjectHarness(options.remote,template.projectId,frozen,selection);
        const profileId=await (explicit?recordHarnessPreparation(journal,input.dispatch.id,template.projectId,frozen,'execution',validate):validate());
        const connection={...template,id:'kanban-'+input.dispatch.id,profileId,...(selection||profileId!==template.profileId?{selection}:{})};
        const existing=await options.connections.get(connection.id);
        if(existing)requireValue(JSON.stringify(existing.connection)===JSON.stringify(connection),'WORK_CONNECTION_CHANGED');
        else await options.connections.save(connection,0);
        return publishManagedAgent(options.agents,journal,{...source.definition,id:connection.id,config:{...source.definition.config,systemPromptId:undefined,systemPrompt:[source.definition.config.systemPrompt,...source.systemPrompt?.content??[]].filter(Boolean).join('\n\n')},execution:{kind:'harness',connectionId:connection.id}});
    });
}

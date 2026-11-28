import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {developmentPreparation} from './kanban-development';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {requireValue} from '../kanban/validation';
import {decisionHarnessProfile,decisionHarnessModel,freezeKanbanHarness,readFrozenHarness,readHarnessChoice,harnessRetryTarget,selectProjectHarness,recordHarnessPreparation} from './kanban-harness-settings';
import {publishManagedAgent} from '../configuration/managed-agent';
import {developmentStage} from './kanban-development-log';
type Options=Parameters<typeof developmentPreparation>[0];
/** Bind new direct Agent executions without changing the reusable Agent or connection. */
export function kanbanHarnessTarget(options:Options):NonNullable<PersonalKanbanAutomationOptions['prepareTarget']>{
    const journal=new KanbanAutomationJournal(options.fs,kanbanJournalOptions);
    return input=>developmentStage(input.dispatch.id,'harness.target',async()=>{
        const retry=harnessRetryTarget(input.dispatch.continuation?.preparation,'execution');
        const explicit=retry??decisionHarnessProfile(input.context,'execution'),manualModel=retry?undefined:decisionHarnessModel(input.context,'execution');
        const old=await readFrozenHarness(journal,input.dispatch.id,manualModel);
        const selected=old??(explicit?{profileId:explicit,selection:manualModel}:readHarnessChoice('execution',input.board.settings));
        const inherited=selected===undefined&&input.target.kind==='agent'?await options.readHarnessDefault?.('execution'):undefined;
        const readSource=()=>input.target.kind==='agent'?options.agents.getAgentRevision?.(input.target.id,input.target.version):undefined;
        const inheritedSource=inherited?await readSource():undefined;
        const preferred=inheritedSource?.definition.execution?.kind==='harness'?inherited:undefined;
        const frozen=await freezeKanbanHarness(journal,input.dispatch.id,input.board.id,'execution',selected??preferred??{profileId:''});
        if(!frozen.profileId)return input.target;
        const selection=frozen.selection;
        const source=inherited?inheritedSource:await readSource();
        requireValue(source?.target.digest===input.target.digest&&source.definition.execution?.kind==='harness','NATIVE_AGENT_REQUIRED');
        const record=await options.connections.get(source.definition.execution.connectionId),template=record?.connection;
        requireValue(template&&template.enabled!==false,'NATIVE_CONNECTION_REQUIRED');
        requireValue(!explicit||!input.projectId||template.projectId===input.projectId,'KANBAN_HARNESS_WORKSPACE_MISMATCH');
        const validate=()=>selectProjectHarness(options.remote,template.projectId,frozen.profileId,selection);
        const profileId=await ((explicit||selection)?recordHarnessPreparation(journal,input.dispatch.id,template.projectId,frozen.profileId,'execution',validate):validate());
        const connection={...template,id:'kanban-'+input.dispatch.id,profileId,...(selection||profileId!==template.profileId?{selection}:{})};
        const existing=await options.connections.get(connection.id);
        if(existing)requireValue(JSON.stringify(existing.connection)===JSON.stringify(connection),'WORK_CONNECTION_CHANGED');
        else await options.connections.save(connection,0);
        return publishManagedAgent(options.agents,journal,{...source.definition,id:connection.id,config:{...source.definition.config,systemPromptId:undefined,systemPrompt:[source.definition.config.systemPrompt,...source.systemPrompt?.content??[]].filter(Boolean).join('\n\n')},execution:{kind:'harness',connectionId:connection.id}});
    });
}

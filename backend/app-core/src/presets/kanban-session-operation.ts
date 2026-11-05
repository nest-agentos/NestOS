import {developmentStage} from './kanban-development-log';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {IFileSystem} from '@nestos/vfs-core';
import type {RemoteFileSourceProvider,ProjectRemoteMountService} from '../projects/remote-mounts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {developmentPolicy} from './kanban-development-policy';
import {currentChannelBinding,openDevelopmentChannel,type DevelopmentWorkspaceRecord} from './kanban-development';
import {publishPromptBundle} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';
interface Options {fs:IFileSystem;journal:KanbanAutomationJournal;remote:ProjectRemoteMountService;provider:RemoteFileSourceProvider;projects:Pick<ProjectService,'get'|'openWorkspace'>}
/** A new immutable communication scope shares the original working directory and native Session. */
export function developmentSessionOperation(options:Options):NonNullable<PersonalKanbanAutomationOptions['collaboration']>['prepare'] {
    return input=>developmentStage(input.id,'session-operation.prepare',async()=>{
        const original=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+input.originId);
        requireValue(original&&input.nativeSessionId,'CONTINUATION_WORKSPACE_UNAVAILABLE');
        const current=await options.remote.sessionChannel(original.projectId,'current',{cwd:original.directory}) as {scopeId?:string};
        if(current.scopeId&&current.scopeId!==input.id) {
            const envelope=await options.remote.sessionChannel(original.projectId,'messages',{scopeId:current.scopeId}) as {execution?:{status?:string}};
            requireValue(!['running','submitting'].includes(envelope.execution?.status??''),'CONTINUATION_IN_USE');
        }
        const folder=await options.projects.get(original.projectId),view=await options.projects.openWorkspace(folder.path);
        try {
            const policy=await developmentPolicy(options.journal,options.fs,view.fs,input.id,{profile:original.policy.profile,commit:original.policy.commit,modules:original.policy.modules.join(',')});
            const entry=input.item.planning?.execution==='children'?'task-coordinate-pre.md':'task-fix-pre.md';
            const record=await options.journal.update<DevelopmentWorkspaceRecord>('development-workspace:'+input.id,old=>old??{...original,channelId:input.id,policy,
                communicationDirectory:original.directory+'/_nestos/kanban/operations/'+input.id,context:input.context});
            await publishPromptBundle(view.fs,record.communicationDirectory!,policy.prompts,{operationId:input.id,entry:'prompts/'+entry,input:input.context});
            const identity={runId:input.item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??input.id,itemId:input.item.id,attemptId:input.id};
            await openDevelopmentChannel(options.remote,input.id,record,identity,input.item,await currentChannelBinding(options.remote,record,input.nativeSessionId));
            return `Continue this SAME Session in coordination mode. Read ${entry} and context through session_context. Scope: ${input.id}. Preserve completed work; do not restart development.`;
        }finally{await view.dispose();}
    });
}

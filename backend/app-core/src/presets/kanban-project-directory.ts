import {sha256HexSync} from '@nestos/common';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import prompts from '../resources/kanban/project-directory-prompts.json';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {requireValue} from '../kanban/validation';
import {freezePrompts,publishPromptBundle} from '../run/prompt-bundle';
import {resolveNativeWork,publishNativeWork,requireNativeWorkspaceHarness,type NativeWorkspaceOptions,type NativeWorkInput} from './kanban-native-workspace';
import {openNativeWorkChannel,recordWorkspacePublication,scopedWorkContext,workChannelScope,type NativeWorkChannel} from './kanban-work-channel';
import {developmentStage} from './kanban-development-log';

export const projectDirectoryPreparation={system:'nestos-work-preparation',id:'project-directory',revision:'1'} as const;
export function isProjectDirectoryPreparation(reference:{system:string;id:string;revision?:string}):boolean {
    return reference.system===projectDirectoryPreparation.system&&reference.id===projectDirectoryPreparation.id&&reference.revision===projectDirectoryPreparation.revision;
}

export function prepareKanbanProjectDirectory(options:NativeWorkspaceOptions) {
    const journal=new KanbanAutomationJournal(options.fs,kanbanJournalOptions);
    return async(input:NativeWorkInput)=>{
        requireValue(isProjectDirectoryPreparation(input.preparation),'WORK_PREPARATION_UNSUPPORTED');
        const id=input.dispatch.id,directory='_nestos/kanban/runs/'+id;
        const binding=await resolveNativeWork(options,journal,input);
        await developmentStage(id,'harness.profiles',()=>requireNativeWorkspaceHarness(options,binding.projectId,binding.profileId));
        await prepareDirectory(options,journal,input,binding.projectId,directory);
        const entry=input.stage==='decision'?'decision.md':'task.md';
        const target=await publishNativeWork(options,journal,input,binding,directory,
            'Read '+entry+' and session-protocol.md via session_context. Use the confirmed project and task scope.');
        return {target,contextRef:{scopeId:id,sections:['task']}};
    };
}

async function prepareDirectory(options:NativeWorkspaceOptions,journal:KanbanAutomationJournal,input:NativeWorkInput,projectId:string,directory:string) {
    const id=input.dispatch.id,project=await options.projects.get(projectId),scoped=scopedWorkContext(options.remote,input,projectId);
    const frozen=await freezePrompts(journal,'project-directory-prompts:'+id,async()=>Object.entries(prompts)
        .map(([name,content])=>({name,content,sha256:sha256HexSync(content),source:'builtin:project-directory'})));
    const record=await journal.update<NativeWorkChannel&{directoryOnly:true;policy:{prompts:typeof frozen}}>('development-workspace:'+id,old=>old??{
        channelId:id,projectId,directory,directoryOnly:true,...scoped,policy:{prompts:frozen}});
    requireValue(record.directoryOnly&&record.projectId===projectId&&record.directory===directory,'WORK_CONNECTION_CHANGED');
    const scope=workChannelScope(input),view=await developmentStage(id,'workspace.open',()=>options.projects.openWorkspace(project.path));
    try{
        const digest=await developmentStage(id,'directory.prepare',()=>publishPromptBundle(view.fs,'/workspace/'+directory,record.policy.prompts,scope));
        await recordWorkspacePublication(journal,id,digest);
        const planning=record.policy.prompts.files.find(file=>file.name==='planning.md')?.content??prompts['planning.md'];
        await developmentStage(id,'channel.open',()=>openNativeWorkChannel(options.remote,record,scope,input.item,record.policy.prompts,planning));
    }finally{await view.dispose();}
}

import {resolveNativeWork,publishNativeWork,requireNativeWorkspaceHarness,type NativeWorkspaceOptions,type NativeWorkInput} from './kanban-native-workspace';
import {openNativeWorkChannel,recordWorkspacePublication,scopedWorkContext,workChannelScope,type NativeWorkChannel} from './kanban-work-channel';
import {registerWorkResource} from './kanban-work-resource-catalog';
import {initializeResourceIndex} from '@nestos/kanban/integration';
import {decisionDeliveryPolicy, selectedDeliveryProfile,validateDeliveryDecomposition} from '@nestos/git-delivery/policy';
import {deliveryEvidence} from './kanban-delivery-plan';
import {planningSections} from './kanban-planning-sections';
import {readGitCommitIdentity, type GitCommitIdentity} from '@nestos/git-delivery/identity';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {developmentPrompts as defaults} from '../resources/catalog';
import {freezeCommitContext, type CommitContext} from '@nestos/git-delivery/provenance';
import {publishImmutableFile} from '../run/prompt-bundle';
import {lifecyclePromptFiles} from '../run/prompt-lifecycle';
import {developmentStage,developmentDeliveryChoice} from './kanban-development-log';
import type {RemoteFileSourceProvider, ProjectRemoteMountService} from '../projects/remote-mounts';
import {prepareWorktree} from '@nestos/git-delivery/worktrees';
import {prepareWorktreeModules, availableWorktreeModules, type WorktreeRepository} from '@nestos/git-delivery/repositories';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {publishPromptBundle} from '../run/prompt-bundle';
import {developmentPolicy, type DevelopmentPolicy} from './kanban-development-policy';
import {developmentWorkspace} from './kanban-development-workspace';

interface Options extends NativeWorkspaceOptions {provider:RemoteFileSourceProvider}
type Input=NativeWorkInput;
export interface DevelopmentWorkspaceRecord extends NativeWorkChannel {
    directoryOnly?:true;worktreeId?:string;communicationDirectory?:string;repositories:WorktreeRepository[];availableRepositories:WorktreeRepository[];
    policy:DevelopmentPolicy;gitIdentity?:GitCommitIdentity;commitContext?:CommitContext;
}

/** Product policy selects resources; generic Kanban persists opaque preparation options. */
export function developmentPreparation(options: Options): NonNullable<PersonalKanbanAutomationOptions['prepareWork']> {
    const journal = new KanbanAutomationJournal(options.fs, kanbanJournalOptions);
    return async input => {
        requireValue(input.preparation.system==='nestos-work-preparation'&&input.preparation.id==='git-worktree'&&input.preparation.revision==='1','WORK_PREPARATION_UNSUPPORTED');
        const binding=await resolveNativeWork(options,journal,input);
        const {source,projectId,profileId}=binding,directory='_nestos/worktrees/'+input.dispatch.id;
        await registerWorkResource(journal,input.dispatch.id,{projectId,context:input.context});
        const instructions=[source.definition.config.systemPrompt,...source.systemPrompt?.content??[]].filter(Boolean).join('\n\n');
        const work=input.stage==='decision'?{...input,options:{...input.options,commit:'changes',modules:''}}:input;
        const record=await prepareWorkspace(options,journal,work,projectId,profileId,directory,instructions);
        await input.reportActivity?.({stage:'worktree.prepared',result:'success',fields:{directory:record.directory,branch:record.repositories[0]?.branch??'',baseCommit:record.repositories[0]?.baseCommit??''},
            references:[{system:'nestos-worktree',id:input.dispatch.id,revision:JSON.stringify({projectId,directory:record.directory,repositories:record.repositories})}]});
        const entry=input.stage==='decision'?'decision.md':input.stage==='fix'?'task-fix-pre.md':'task.md';
        const pre=lifecyclePromptFiles(record.policy.prompts,input.stage==='decision'?'decision':input.stage==='fix'?'task-fix':'task','pre');
        const target=await publishNativeWork(options,journal,input,binding,directory,channelInstruction(record.policy,entry,pre));
        return {target,contextRef:{scopeId:record.channelId,sections:['task']}};
    };
}
async function prepareWorkspace(options: Options, journal: KanbanAutomationJournal, input: Input, projectId: string, profileId: string, directory: string, instructions: string): Promise<DevelopmentWorkspaceRecord> {
    const scoped=scopedWorkContext(options.remote,input,projectId);
    const {contextProjects}=scoped;
    await developmentStage(input.dispatch.id, 'harness.profiles', () => requireNativeWorkspaceHarness(options, projectId, profileId));
    const folder = await options.projects.get(projectId), view = await developmentStage(input.dispatch.id, 'workspace.open', () => options.projects.openWorkspace(folder.path));
    try {
        const policy = await developmentStage(input.dispatch.id, 'policy.freeze', () => developmentPolicy(journal,options.fs,view.fs,input.dispatch.id,input.options));
        let context=scoped.context;
        const selected=await developmentStage(input.dispatch.id,'delivery.policy',async()=>decisionDeliveryPolicy(policy,context));
        developmentDeliveryChoice(input.dispatch.id,selected);
        if(input.stage==='decision'&&context)context={...context as object,snapshot:{...(context as {snapshot?:object}).snapshot,delivery:selected}};
        const profile=input.stage===undefined?selectedDeliveryProfile(policy,input.item,context):undefined;
        if(profile)context={...context as object,delivery:{...profile,verificationLevel:selected?.verificationLevel,deliveryMode:selected?.deliveryMode,...(profile.readOnly?{evidence:await deliveryEvidence(journal,context)}:{})}};
        const record = await developmentWorkspace(options.remote, options.provider, projectId, async process => {
            const existing = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id);
            if(!existing)await initializeResourceIndex(journal,input.dispatch.id);
            const gitIdentity = existing ? existing.gitIdentity : policy.commit === 'worktree' ? await developmentStage(input.dispatch.id, 'git.identity', () => readGitCommitIdentity(process)) : undefined;
            const tree = await developmentStage(input.dispatch.id, 'worktree.prepare', () => prepareWorktree(journal, input.dispatch.id, '/workspace/' + directory, process));
            const repositories = await developmentStage(input.dispatch.id, 'modules.prepare', () => prepareWorktreeModules(journal, tree, policy.modules, process));
            const availableRepositories = await availableWorktreeModules(process, tree);
            return journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id,
                old => old ?? {channelId: input.dispatch.id, projectId,contextProjects,directory: tree.directory, repositories, availableRepositories, policy, gitIdentity, instructions,...(context===undefined?{}:{context})});
        });
        if ((record.context as {board?: {id?: string}})?.board?.id) {
            const commitContext = record.commitContext ?? await freezeCommitContext(journal, {projectId, boardId: (record.context as {board:{id:string}}).board.id, itemId: input.item.id, itemRevision: input.item.revision, executionId: input.dispatch.id, context: record.context});
            const enriched = await journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id, old => ({...old!, commitContext: old!.commitContext ?? commitContext}));
            record.commitContext = enriched.commitContext;
            await publishImmutableFile(view.fs, record.directory + '/_nestos/kanban', 'commit-trailers.txt', commitContext.trailers);
        }
        const scope=workChannelScope(input);
        const digest = await developmentStage(input.dispatch.id, 'prompts.publish', () => publishPromptBundle(view.fs, record.directory + '/_nestos/kanban', record.policy.prompts,
            {...scope, entry: input.stage === 'decision' ? 'prompts/decision.md' : input.stage === 'fix' ? 'prompts/task-fix-pre.md' : 'prompts/task.md', commit: policy.commit, gitIdentity: record.gitIdentity, repositories: record.repositories, availableRepositories: record.availableRepositories,...(record.context===undefined?{}:{input:planningSections(record.context).context})}));
        await recordWorkspacePublication(journal, input.dispatch.id, digest);
        await openDevelopmentChannel(options.remote, input.dispatch.id, record, scope, input.item);
        await registerWorkResource(journal,input.dispatch.id,record);
        return record;
    } finally {await view.dispose();}
}
export function channelInstruction(policy: DevelopmentPolicy, entry: string, pre: string[]): string {
    const sections=entry==='decision.md'?'instructions, decision.md':`identity, instructions, ${[...pre,entry].join(', ')}`;
    const template=policy.prompts.files.find(file=>file.name==='bootstrap.md')?.content??defaults['bootstrap.md'];
    return template.replace(/\{\{(sections|commit)\}\}/g,(_match,key:string)=>key==='sections'?sections:policy.commit);

}

export async function openDevelopmentChannel(remote: Pick<ProjectRemoteMountService, 'sessionChannel'>, id: string, record: DevelopmentWorkspaceRecord,
    identity: {runId: string; itemId: string; attemptId: string}, task: unknown, binding?: {previousScopeId: string; previousSessionId: string; sessionId?: string}): Promise<void> {
    requireValue(record.channelId===id,'SESSION_CHANNEL_SCOPE_REQUIRED');
    const planning=record.policy.prompts.files.find(file=>file.name==='planning.md')?.content??defaults['planning.md'];
    const policy={commit:record.policy.commit,gitIdentity:record.gitIdentity,repositories:record.repositories,availableRepositories:record.availableRepositories};
    return openNativeWorkChannel(remote,record,identity,task,record.policy.prompts,planning,binding,record.directoryOnly?undefined:{policy});
}

export {currentChannelBinding} from './kanban-work-channel';

export function validateSoftwarePlanning(workspace:NativeWorkChannel&{directoryOnly?:true},output:unknown):void {
    if(workspace.directoryOnly)return;
    const {policy,context}=workspace as DevelopmentWorkspaceRecord;
    validateDeliveryDecomposition(policy,output,context);
}

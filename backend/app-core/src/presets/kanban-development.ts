import {initializeResourceIndex} from '../kanban/resource-operation-index';
import {deliveryPolicy,deliveryProfile,deliveryEvidence} from './kanban-delivery-plan';
import {planningSections} from './kanban-planning-sections';
import {readGitCommitIdentity, type GitCommitIdentity} from './kanban-git-identity';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {developmentPrompts as defaults} from '../resources/catalog';
import {freezeCommitContext, type CommitContext} from './kanban-commit-context';
import {publishImmutableFile} from '../run/prompt-bundle';
import {lifecyclePromptFiles} from '../run/prompt-lifecycle';
import {developmentStage} from './kanban-development-log';
import type {AgentDefinition, IAgentManagementService} from '@nestos/kernel-adapters/contracts';
import type {IFileSystem} from '@nestos/vfs-core';
import type {RemoteFileSourceProvider, ProjectRemoteMountService} from '../projects/remote-mounts';
import type {HarnessConnectionService} from '../projects/harness-connections';
import {publishManagedAgent} from '../configuration/managed-agent';
import {prepareWorktree} from '../projects/worktree-preparation';
import {prepareWorktreeModules, availableWorktreeModules, type WorktreeRepository} from '../projects/worktree-modules';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
import {REMOTE_PROJECT_REFERENCE} from '../kanban/resource-catalog';
import type {PersonalKanbanAutomationOptions} from '../kanban/personal-automation';
import {publishPromptBundle} from '../run/prompt-bundle';
import {developmentPolicy, type DevelopmentPolicy} from './kanban-development-policy';
import {developmentWorkspace} from './kanban-development-workspace';

interface Options {fs: IFileSystem; agents: IAgentManagementService; connections: HarnessConnectionService;
    remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    projects: Pick<import('@nestos/app-contracts/services').ProjectService, 'get' | 'openWorkspace'>}
type Input = Parameters<NonNullable<PersonalKanbanAutomationOptions['prepareWork']>>[0];
export interface DevelopmentWorkspaceRecord {projectId: string; directory: string; worktreeId?: string; communicationDirectory?: string; repositories: WorktreeRepository[]; availableRepositories: WorktreeRepository[]; policy: DevelopmentPolicy; gitIdentity?: GitCommitIdentity; context?:unknown; commitContext?: CommitContext; channelId: string; instructions?: string}

/** Product policy selects resources; generic Kanban persists opaque preparation options. */
export function developmentPreparation(options: Options): NonNullable<PersonalKanbanAutomationOptions['prepareWork']> {
    const journal = new KanbanAutomationJournal(options.fs, kanbanJournalOptions);
    return async input => {
        requireValue(input.preparation.system === 'nestos-work-preparation' && input.preparation.id === 'git-worktree' && input.preparation.revision === '1', 'WORK_PREPARATION_UNSUPPORTED');
        requireValue(input.target.kind === 'agent', 'NATIVE_AGENT_REQUIRED');
        const source = await developmentStage(input.dispatch.id, 'agent.resolve', async () => options.agents.getAgentRevision?.(input.target.id, input.target.version));
        requireValue(source?.target.digest === input.target.digest && source.definition.execution?.kind === 'harness', 'NATIVE_AGENT_REQUIRED');
        const selected = input.item.externalRefs?.filter(ref => ref.system === REMOTE_PROJECT_REFERENCE) ?? [];
        requireValue(selected.length === 1, 'SINGLE_PROJECT_TASK_REQUIRED');
        const connectionId = source.definition.execution.connectionId;
        const template = await developmentStage(input.dispatch.id, 'connection.resolve', () => options.connections.get(connectionId));
        requireValue(template?.connection && template.connection.enabled !== false, 'NATIVE_CONNECTION_REQUIRED');
        const projectId = selected[0].id, directory = '_nestos/worktrees/' + input.dispatch.id;
        const record = await prepareWorkspace(options, journal, input, projectId, template.connection.profileId, directory, [source.definition.config.systemPrompt, ...source.systemPrompt?.content ?? []].filter(Boolean).join('\n\n'));
        await input.reportActivity?.({stage: 'worktree.prepared', result: 'success', fields: {directory: record.directory, branch: record.repositories[0]?.branch ?? '', baseCommit: record.repositories[0]?.baseCommit ?? ''},
            references: [{system: 'nestos-worktree', id: input.dispatch.id, revision: JSON.stringify({projectId, directory: record.directory, repositories: record.repositories})}]});
        const root = options.remote.list(projectId).find(mount => mount.at === '/')!;
        const connection = {...template.connection, id: 'work-' + input.dispatch.id, projectId, nodeConnectionId: root.connectionId!, directory};
        const existing = await options.connections.get(connection.id);
        if (existing) requireValue(JSON.stringify(existing.connection) === JSON.stringify(connection), 'WORK_CONNECTION_CHANGED');
        else await options.connections.save(connection, 0);
        const definition = workerDefinition(source.definition, input, connection.id, record.policy);
        const target = await developmentStage(input.dispatch.id, 'agent.publish', () => publishManagedAgent(options.agents, journal, definition));
        await input.reportActivity?.({stage: 'agent.prepared', result: 'success', fields: {agentId: target.id}});
        return {target,contextRef:{scopeId:record.channelId,sections:['task','context']}};
    };
}
async function prepareWorkspace(options: Options, journal: KanbanAutomationJournal, input: Input, projectId: string, profileId: string, directory: string, instructions: string): Promise<DevelopmentWorkspaceRecord> {
    await developmentStage(input.dispatch.id, 'harness.profiles', () => requireDevelopmentHarness(options, projectId, profileId));
    const folder = await options.projects.get(projectId), view = await developmentStage(input.dispatch.id, 'workspace.open', () => options.projects.openWorkspace(folder.path));
    try {
        const policy = await developmentStage(input.dispatch.id, 'policy.freeze', () => developmentPolicy(journal,options.fs,view.fs,input.dispatch.id,{...input.options,...(input.stage===undefined&&(input.context as {decision?:{snapshot?:{completion?:string}}})?.decision?.snapshot?.completion==='automatic'?{commit:'worktree'}:{})}));
        let context=input.context;
        if(input.stage==='decision'&&context)context={...context as object,snapshot:{...(context as {snapshot?:object}).snapshot,delivery:deliveryPolicy(policy)}};
        const profile=input.stage===undefined?deliveryProfile(policy,input.item):undefined;
        if(profile)context={...context as object,delivery:{...profile,...(profile.readOnly?{evidence:await deliveryEvidence(journal,context)}:{})}};
        const record = await developmentWorkspace(options.remote, options.provider, projectId, async process => {
            const existing = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id);
            if(!existing)await initializeResourceIndex(journal,input.dispatch.id);
            const gitIdentity = existing ? existing.gitIdentity : policy.commit === 'worktree' ? await developmentStage(input.dispatch.id, 'git.identity', () => readGitCommitIdentity(process)) : undefined;
            const tree = await developmentStage(input.dispatch.id, 'worktree.prepare', () => prepareWorktree(journal, input.dispatch.id, '/workspace/' + directory, process));
            const repositories = await developmentStage(input.dispatch.id, 'modules.prepare', () => prepareWorktreeModules(journal, tree, policy.modules, process));
            const availableRepositories = await availableWorktreeModules(process, tree);
            return journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id,
                old => old ?? {channelId: input.dispatch.id, projectId, directory: tree.directory, repositories, availableRepositories, policy, gitIdentity, instructions,...(context===undefined?{}:{context})});
        });
        if ((record.context as {board?: {id?: string}})?.board?.id) {
            const commitContext = record.commitContext ?? await freezeCommitContext(journal, {projectId, boardId: (record.context as {board:{id:string}}).board.id, itemId: input.item.id, itemRevision: input.item.revision, executionId: input.dispatch.id, context: record.context});
            const enriched = await journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + input.dispatch.id, old => ({...old!, commitContext: old!.commitContext ?? commitContext}));
            record.commitContext = enriched.commitContext;
            await publishImmutableFile(view.fs, record.directory + '/_nestos/kanban', 'commit-trailers.txt', commitContext.trailers);
        }
        const scope = {runId: input.item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? input.dispatch.planId,
            itemId: input.item.id, attemptId: input.dispatch.id};
        const digest = await developmentStage(input.dispatch.id, 'prompts.publish', () => publishPromptBundle(view.fs, record.directory + '/_nestos/kanban', record.policy.prompts,
            {...scope, entry: input.stage === 'decision' ? 'prompts/decision.md' : input.stage === 'fix' ? 'prompts/task-fix-pre.md' : 'prompts/task.md', commit: policy.commit, gitIdentity: record.gitIdentity, repositories: record.repositories, availableRepositories: record.availableRepositories,...(record.context===undefined?{}:{input:record.context})}));
        await recordPublication(journal, input.dispatch.id, digest);
        await openDevelopmentChannel(options.remote, input.dispatch.id, record, scope, input.item);
        return record;
    } finally {await view.dispose();}
}
async function requireDevelopmentHarness(options: Options, projectId: string, profileId: string): Promise<void> {
    const harness = await options.remote.projectHarness(projectId, {requireRegistered: true});
    try {const capabilities = (await harness.profiles()).profiles.find(profile => profile.id === profileId)?.capabilities; requireValue(capabilities?.workingDirectory, 'NATIVE_WORKING_DIRECTORY_UNSUPPORTED'); requireValue(capabilities.sessionChannels === true, 'NATIVE_SESSION_CHANNEL_REQUIRED');}
    finally {await harness.close();}
}
function workerDefinition(source: AgentDefinition, input: Input, connectionId: string, policy: DevelopmentPolicy): AgentDefinition {
    const entry = input.stage === 'decision' ? 'decision.md' : input.stage === 'fix' ? 'task-fix-pre.md' : 'task.md';
    const pre=lifecyclePromptFiles(policy.prompts,input.stage==='decision'?'decision':input.stage==='fix'?'task-fix':'task','pre');
    return {...source, id: 'work-' + input.dispatch.id, name: input.item.title,
        memoryPolicy: {namespaceId: source.memoryPolicy?.namespaceId ?? 'agent', readScopes: [], writeScopes: [], retrievalLimit: 0},
        config: {...source.config, systemPromptId: undefined, systemPrompt: channelInstruction(policy, entry, pre)}, execution: {kind: 'harness', connectionId}};
}

async function recordPublication(journal: KanbanAutomationJournal, id: string, digest: string): Promise<void> {
    await journal.update<{sha256: string}>('development-publication:' + id, old => {
        requireValue(!old || old.sha256 === digest, 'PROMPT_MANIFEST_CHANGED'); return old ?? {sha256: digest};
    });
}

export function channelInstruction(policy: DevelopmentPolicy, entry: string, pre: string[]): string {
    const sections=entry==='decision.md'?'instructions, decision.md, planning, planning-input':`identity, policy, instructions, ${[...pre,entry].join(', ')}`;
    const template=policy.prompts.files.find(file=>file.name==='bootstrap.md')?.content??defaults['bootstrap.md'];
    return template.replace(/\{\{(sections|commit)\}\}/g,(_match,key:string)=>key==='sections'?sections:policy.commit);

}

export async function openDevelopmentChannel(remote: Pick<ProjectRemoteMountService, 'sessionChannel'>, id: string, record: DevelopmentWorkspaceRecord,
    identity: {runId: string; itemId: string; attemptId: string}, task: unknown, binding?: {previousScopeId: string; previousSessionId: string; sessionId?: string}): Promise<void> {
    requireValue(record.channelId === id, 'SESSION_CHANNEL_SCOPE_REQUIRED');
    await remote.sessionChannel(record.projectId, 'open', {scopeId: id, cwd: record.directory, ...binding,
        snapshot: {identity, task, instructions: record.instructions ?? '', planning: record.policy.prompts.files.find(file=>file.name==='planning.md')?.content??defaults['planning.md'], ...planningSections(record.context),
            policy: {commit: record.policy.commit, gitIdentity: record.gitIdentity, repositories: record.repositories, availableRepositories: record.availableRepositories},
            ...Object.fromEntries(record.policy.prompts.files.map(file => [file.name, {content: file.content, sha256: file.sha256}]))}});
}

/** Fence the exact previous execution while selecting the next native Session explicitly. */
export async function currentChannelBinding(remote:Pick<ProjectRemoteMountService,'sessionChannel'>,record:DevelopmentWorkspaceRecord,sessionId?:string) {
    const active=await remote.sessionChannel(record.projectId,'current',{cwd:record.directory}) as {scopeId?:unknown;execution?:{sessionId?:unknown}};
    if(active.scopeId===record.channelId)return undefined;
    requireValue(typeof active.scopeId==='string'&&typeof active.execution?.sessionId==='string','CHANNEL_EXECUTION_UNKNOWN');
    return {previousScopeId:active.scopeId,previousSessionId:active.execution.sessionId,...(sessionId?{sessionId}:{})};
}

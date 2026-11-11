import type {IFileSystem} from '@nestos/vfs-core';
import type {ContinueWorkOptions} from '../kanban/continued-work';
import type {ResourceExecutionOptions} from './kanban-work-resource-execution';
import {workResourceExecution} from './kanban-work-resource-execution';
import type {RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {PreparedWorktree} from '@nestos/git-delivery/worktrees';
import {inspectWorktree} from '@nestos/git-delivery/inspection';
import {developmentWorkspace} from './kanban-development-workspace';
import {currentChannelBinding, openDevelopmentChannel, channelInstruction, type DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentPolicy} from './kanban-development-policy';
import {publishImmutableFile} from '../run/prompt-bundle';
import {publishPromptBundle} from '../run/prompt-bundle';
import {requireValue} from '../kanban/validation';

interface Options extends ResourceExecutionOptions {fs: IFileSystem; provider: RemoteFileSourceProvider;
    projects: Pick<ProjectService, 'get' | 'openWorkspace'>}
/** Reuse the original repository and communication history; open a separate immutable channel scope. */
export function developmentContinuation(options: Options): NonNullable<ContinueWorkOptions['prepare']> {
    return async input => {
        const journal = options.journal, id = input.originalDispatch.id;
        const original = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + id);
        const tree = await journal.get<PreparedWorktree>('worktree:' + id);
        requireValue(input.nativeSessionId, 'CONTINUATION_NATIVE_SESSION_UNKNOWN');
        requireValue(original && tree && !await journal.get('worktree-cleanup:' + id), 'CONTINUATION_WORKSPACE_UNAVAILABLE');
        requireValue(input.item.externalRefs?.some(ref => ref.system === 'nestos-remote-project' && ref.id === original.projectId), 'WORKTREE_PROJECT_CHANGED');
        const reasons = await workResourceExecution(options,id,original.projectId,{purpose:'resume',operationId:input.dispatch.id});
        requireValue(!reasons.length, reasons[0] ?? 'CONTINUATION_IN_USE');
        await developmentWorkspace(options.remote, options.provider, original.projectId, async process => {
            requireValue((await inspectWorktree(process, tree, '_nestos/kanban/')).exists, 'WORKTREE_MISSING');
        });
        const folder = await options.projects.get(original.projectId), view = await options.projects.openWorkspace(folder.path);
        try {
            const record = await publishContinuation(options, input, original, tree, view.fs);
            return `Continue the original task in this SAME Session and worktree. The host admitted scope ${input.dispatch.id}; previous attempts are historical. `
                + channelInstruction(record.policy, 'task.md', ['task-continue-pre.md','task-recovery-pre.md'])
                + (input.dispatch.continuation?.instruction ?? 'Inspect retained work and finish the original acceptance criteria.');
        } finally {await view.dispose();}
    };
}
async function publishContinuation(options: Options, input: Parameters<NonNullable<ContinueWorkOptions['prepare']>>[0], original: DevelopmentWorkspaceRecord,
    tree: PreparedWorktree, fs: IFileSystem): Promise<DevelopmentWorkspaceRecord> {
    const {dispatch, item} = input, journal = options.journal;
    const policy = await developmentPolicy(journal, options.fs, fs, dispatch.id,
        {profile: original.policy.profile, commit: original.policy.commit, modules: original.policy.modules.join(',')});
    const recovery=await journal.get<{approved:boolean;itemId:string;previousDispatchId:string;operationId:string;version:string;serviceId:string}>('task-recovery-evidence:'+dispatch.id);
    if(recovery)requireValue(recovery.approved&&recovery.itemId===item.id&&recovery.previousDispatchId===dispatch.continuation!.previousDispatchId,'RECOVERY_EVIDENCE_SCOPE_MISMATCH');
    const delivery=(original.context as {delivery?:{readOnly?:boolean;evidence?:object}})?.delivery;
    if(recovery)requireValue(delivery?.readOnly,'RECOVERY_EVIDENCE_SCOPE_MISMATCH');
    const record = await journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + dispatch.id, old => old ?? {...original, channelId: dispatch.id, policy,
        worktreeId: tree.id, communicationDirectory: original.directory + '/_nestos/kanban/continuations/' + dispatch.id,
        context: {...original.context as object,...(recovery?{recovery,delivery:{...delivery,evidence:{...delivery?.evidence,operationId:recovery.operationId,result:{version:recovery.version},recovery:true}}}:{}), task: {id: item.id, parentId: item.planning?.parentId ?? null, title: item.title,
            responsibility: item.responsibility, acceptance: item.acceptance, dependencies: item.planning?.dependencies ?? []},
            continuation: {dispatchId: dispatch.id, previousDispatchId: dispatch.continuation!.previousDispatchId,
            originalDispatchId: input.originalDispatch.id, sessionId: input.sessionId}}});
    await journal.update('worktree:' + dispatch.id, old => old ?? tree);
    const managed = await journal.get('managed-agent:work-' + input.originalDispatch.id);
    requireValue(managed, 'CONTINUATION_TARGET_UNKNOWN');
    await journal.update('managed-agent:work-' + dispatch.id, old => old ?? managed);
    const scope = {runId: item.externalRefs?.find(ref => ref.system === 'nestos-decision-run')?.id ?? dispatch.planId, itemId: item.id, attemptId: dispatch.id};
    if (record.commitContext) await publishImmutableFile(fs, record.communicationDirectory!, 'commit-trailers.txt', record.commitContext.trailers);
    await publishPromptBundle(fs, record.communicationDirectory!, record.policy.prompts, {...scope, entry: 'prompts/task.md', commit: policy.commit, gitIdentity: record.gitIdentity,
        repositories: record.repositories, availableRepositories: record.availableRepositories, input: record.context});
    await openDevelopmentChannel(options.remote, dispatch.id, record, scope, item,
        await currentChannelBinding(options.remote,record,input.nativeSessionId));
    return record;
}

import {verifyReadOnlyDelivery} from './kanban-delivery-plan';
import {kanbanJournalOptions} from '../kanban/host-policy';
import {verifyCommitContexts} from './kanban-commit-context';
import {developmentStage} from './kanban-development-log';
import type {PromptJournal} from '../run/prompt-bundle';
import {sha256HexSync} from '@nestos/common';
import type {RepositoryEvidence} from '../projects/worktree-modules';
import type {IFileSystem} from '@nestos/vfs-core';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import {verifyWorktreeDelivery} from '../projects/worktree-modules';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {developmentWorkspace} from './kanban-development-workspace';
import type {DevelopmentWorkspaceRecord} from './kanban-development';

export function developmentDelivery(fs: IFileSystem, remote: ProjectRemoteMountService, provider: RemoteFileSourceProvider,runningVersion?:string) {
    const journal = new KanbanAutomationJournal(fs, kanbanJournalOptions);
    return async (dispatchId: string) => {
        const record = await journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + dispatchId);
        if (!record) return;
        const repositories = await developmentStage(dispatchId, 'delivery.verify', () => developmentWorkspace(remote, provider, record.projectId,
            async process => {
                const evidence = await verifyWorktreeDelivery(process, record.directory, record.repositories, record.policy.commit, record.availableRepositories);
                verifyReadOnlyDelivery(record,evidence,runningVersion);
                if (record.commitContext && record.policy.commit === 'worktree') {
                    const commits = await verifyCommitContexts(process, record.directory, evidence, record.commitContext);
                    const digest = sha256HexSync(JSON.stringify(evidence));
                    await journal.update('development-commits:' + dispatchId + ':' + digest, old => old ?? {contextDigest: record.commitContext!.digest, repositories: commits});
                }
                return evidence;
            }));
        await recordDeliveryEvidence(journal, dispatchId, record.policy.commit, repositories);
    };
}
/** Every independently verified revision is immutable; a rebuild never overwrites earlier evidence. */
export async function recordDeliveryEvidence(journal: PromptJournal, dispatchId: string, commit: string, repositories: RepositoryEvidence[]): Promise<void> {
    const digest = sha256HexSync(JSON.stringify(repositories));
    await journal.update('development-delivery:' + dispatchId + ':' + digest, old => old ?? {verifiedAt: Date.now(), commit, repositories});
}

import type {ReviewAdapter, ReviewJob} from '@nestos/kanban-development';
import {verifyWorktreeDelivery, type RepositoryEvidence} from '@nestos/git-delivery/repositories';
import {blocksOperation, cancellationKey, type ReviewCancellation} from '@nestos/kanban/integration';
import type {GitApproval, GitProcess, GitSource} from '@nestos/git-delivery/contracts';
import {inspectGitIntegration, resumeGitIntegration, tryGitIntegration, validateGitConflictResolutions, type GitConflictResolution} from '@nestos/git-delivery/integration-transaction';
import {requireValue} from '../kanban/validation';
import type {DevelopmentReviewOptions} from './kanban-development-review';
import {developmentWorkspace} from './kanban-development-workspace';

interface IntegrationRoute {fingerprint: string; kind: 'native' | 'session'; proposalRequired?:true; resolutions?:GitConflictResolution[]}
type FrozenSource = GitSource & {commitPolicy?: 'changes' | 'worktree'};
const routeKey = (job: ReviewJob) => 'review-git-integration:' + job.id;

export async function assertSessionMergeCancellable(journal: ReviewPorts['journal'], job: ReviewJob): Promise<void> {
    if ((await journal.get<IntegrationRoute>(routeKey(job)))?.kind === 'native')
        throw Object.assign(new Error('Git integration is already admitted'), {code: 'OPERATION_CANCEL_UNSUPPORTED', cancelRejected: true});
}

export async function usesHostMergeProposal(journal:ReviewPorts['journal'],job:ReviewJob):Promise<boolean>{
    const route=job.action==='merge'&&await journal.get<IntegrationRoute>(routeKey(job));
    return !!(route&&route.kind==='session'&&route.proposalRequired);
}

type ReviewPorts = Pick<DevelopmentReviewOptions, 'journal' | 'remote' | 'provider'>;

export function kanbanGitIntegration(options: ReviewPorts, sources: (job: ReviewJob) => FrozenSource[] = job => [job.snapshot.context as FrozenSource]):
    NonNullable<ReviewAdapter['gitIntegration']> {
    return {
        async start(job) {
            await options.journal.update<IntegrationRoute>(routeKey(job), current => {
                requireValue(!current, 'OPERATION_IDENTITY_CONFLICT');
                return {kind: 'native', fingerprint: job.fingerprint};
            });
            const frozenSources = sources(job), {projectId, input} = integrationTarget(job, frozenSources);
            const result = await developmentWorkspace(options.remote, options.provider, projectId, async process => {
                await verifyFrozenSources(process, frozenSources);
                requireValue(!blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(job.id))), 'OPERATION_CANCELLING');
                return tryGitIntegration(process, input);
            });
            if (result === 'session') await options.journal.update<IntegrationRoute>(routeKey(job), current => {
                requireValue(current?.fingerprint === job.fingerprint, 'OPERATION_IDENTITY_CONFLICT');
                return {...current, kind: 'session',proposalRequired:true};
            });
            return result;
        },
        requiresProposal:job=>usesHostMergeProposal(options.journal,job),
        async publishProposal(job,output) {
            requireValue(await usesHostMergeProposal(options.journal,job),'INTEGRATION_PUBLICATION_UNKNOWN');
            const frozen=sources(job),{projectId,input}=integrationTarget(job,frozen);
            const proposal=output as {resolutions?:unknown};
            const resolutions=validateGitConflictResolutions(input.approval,proposal?.resolutions);
            return developmentWorkspace(options.remote,options.provider,projectId,async process=>{
                await verifyFrozenSources(process,frozen);
                requireValue(!blocksOperation(await options.journal.get<ReviewCancellation>(cancellationKey(job.id))),'OPERATION_CANCELLING');
                await options.journal.update<IntegrationRoute>(routeKey(job),old=>{
                    requireValue(old?.fingerprint===job.fingerprint&&old.kind==='session'&&old.proposalRequired,'OPERATION_IDENTITY_CONFLICT');
                    return {...old,kind:'native',resolutions};
                });
                requireValue(await tryGitIntegration(process,{...input,resolutions})==='applied','OPERATION_RESULT_INTEGRATION_UNSUPPORTED');
                const targetHead=await inspectGitIntegration(process,{...input,resolutions});
                requireValue(targetHead,'INTEGRATION_PUBLICATION_UNKNOWN');
                return {...output as object,targetHead};
            });
        },
        async inspect(job, resume = false) {
            const route = await options.journal.get<IntegrationRoute>(routeKey(job));
            if (!route || route.kind === 'session') return;
            requireValue(route.fingerprint === job.fingerprint, 'OPERATION_IDENTITY_CONFLICT');
            const {projectId, input} = integrationTarget(job, sources(job));
            const targetHead = await developmentWorkspace(options.remote, options.provider, projectId, process => resume ? resumeGitIntegration(process,{...input,resolutions:route.resolutions}) : inspectGitIntegration(process,{...input,resolutions:route.resolutions}));
            if (!targetHead) return {state: 'unknown', code: job.code?.startsWith('INTEGRATION_') ? job.code : 'INTEGRATION_PUBLICATION_UNKNOWN', sessionId: job.sessionId};
            return {state: 'succeeded', sessionId: job.sessionId, output: {
                schema: 'nestos.kanban.operation-result/1', status: 'succeeded', operationId: job.id,
                sourceVersion: job.snapshot.sourceVersion, targetVersion: job.snapshot.targetVersion, targetHead,
            }};
        },
    };
}

function integrationTarget(job: ReviewJob, sources: GitSource[]) {
    const context = job.snapshot.context as {projectId?: string; targetBranch?: string};
    requireValue(context.projectId && context.targetBranch, 'OPERATION_SCOPE_MISMATCH');
    return {projectId: context.projectId, input: {operationId: job.id, previousTarget: job.snapshot.targetVersion,
        targetBranch: context.targetBranch, sources, approval: job.operationContext as GitApproval}};
}

async function verifyFrozenSources(process: GitProcess, sources: FrozenSource[]): Promise<void> {
    for (const source of sources) {
        const repositories = source.repositories as RepositoryEvidence[] | undefined;
        requireValue(source.commitPolicy && repositories?.length, 'OPERATION_SCOPE_MISMATCH');
        const current = await verifyWorktreeDelivery(process, source.directory, repositories, source.commitPolicy);
        requireValue(current.every((row, index) => row.head === repositories[index]?.head &&
            row.changesDigest === repositories[index]?.changesDigest && row.dirty === repositories[index]?.dirty), 'OPERATION_SOURCE_CHANGED_REANALYZE');
    }
}

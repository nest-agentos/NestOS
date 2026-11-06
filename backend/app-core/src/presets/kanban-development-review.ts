import {retainedExecutionContexts} from '../projects/harness-context-selection';
import {verifyFileDigest} from '../run/file-digest';
import {verifyReadOnlyDelivery} from './kanban-delivery-plan';
import {managedServiceDeployment} from './managed-service-deployment';
import {operationReceipt} from '../run/operation-receipt';
import {maintenanceInstruction} from './kanban-maintenance';
import {journalCommand} from '@nestos/kanban/integration';
import {DirectorySubscriptions} from '../run/directory-subscriptions';
import {preloadCommitContexts} from './kanban-commit-query';
import {developmentChannelExchange} from './kanban-channel-exchange';
import type {sessionSubmission} from '../run/session-submission';
import {t, sha256HexSync} from '@nestos/common';
import type {KanbanBoard, KanbanItem, KanbanService} from '@nestos/kanban/contracts';
import type {IndependentCallService} from '@nestos/llm-session';
import type {SubmissionRequest} from '@nestos/llm-session/contracts';
import type {Kernel} from '@nestos/durable-kernel';
import type {IFileSystem} from '@nestos/vfs-core';
import type {ReviewAdapter, ReviewSnapshot, ReviewJob} from '../kanban/item-operation-types';
import {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
import {readContextCatalog} from '../projects/harness-context-catalog';
import {inspectWorktree} from '../projects/worktree-status';
import {verifyWorktreeDelivery, gitWorkspace} from '../projects/worktree-modules';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import {currentChannelBinding, openDevelopmentChannel, type DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import type {ProjectRemoteMountService, RemoteFileSourceProvider} from '../projects/remote-mounts';
import type {ProjectService} from '@nestos/app-contracts/services';
import {developmentPolicy,requiresDevelopmentProject} from './kanban-development-policy';
import {publishPromptBundle} from '../run/prompt-bundle';
import {publishImmutableFile} from '../run/prompt-bundle';
import {readChannelResult, channelResultInstruction} from '../run/channel-results';
import {workResourceExecution} from './kanban-work-resource-execution';

interface Options {
    serviceControl?:import('../runtime/service-control').RuntimeServiceControl;
    submission?: ReturnType<typeof sessionSubmission>; wake?(): void;
    fs: IFileSystem; journal: KanbanAutomationJournal; service: KanbanService; calls: Pick<IndependentCallService, 'list'>;
    kernel: Pick<Kernel, 'sessionActivity' | 'inspectSession' | 'task'>; remote: ProjectRemoteMountService; provider: RemoteFileSourceProvider;
    projects: Pick<ProjectService, 'get' | 'openWorkspace'>; runningVersion?: string;
}
interface MaintenanceInput {deployment?:import('../runtime/service-control').RuntimeServiceDescriptor;id: string; board: KanbanBoard; item: KanbanItem; snapshot: ReviewSnapshot; action?: Exclude<import('../kanban/item-operation-types').ReviewAction, 'accept'>; context?: unknown}
interface ReviewResource {id: string; tree: PreparedWorktree; record: DevelopmentWorkspaceRecord}
export function developmentReviewAdapter(options: Options): ReviewAdapter {
    const watches = new DirectorySubscriptions();
    const watch = async (job: ReviewJob) => {
        const record = await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + job.id);
        requireValue(record?.communicationDirectory, 'OPERATION_WORKSPACE_UNAVAILABLE');
        await watches.ensure(job.id, async () => {const client = await options.remote.projectHarness(record.projectId);
            requireValue(client.subscribeChannel, 'SESSION_CHANNEL_REQUIRED');
            const stop = client.subscribeChannel(job.id, () => options.wake?.());
            return async () => {stop?.(); await client.close();};});
        return record;
    };
    const managed=managedServiceDeployment(options.serviceControl,async item=>{const project=item.externalRefs?.find(ref=>ref.system==='nestos-remote-project');requireValue(project,'SINGLE_PROJECT_TASK_REQUIRED');return options.projects.openWorkspace((await options.projects.get(project.id)).path);},async job=>{requireValue((await snapshot(options,await options.service.read(job.boardId),(await options.service.item(job.boardId,job.itemId)).item)).version===job.snapshot.version,'OPERATION_SOURCE_CHANGED_REBUILD');});
    return {managed,runningVersion: () => options.runningVersion, supports: (board, item) => !!item.externalRefs?.some(ref => ref.system === 'nestos-worktree')||requiresDevelopmentProject(board)&&!!item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'),
        snapshot: (board, item) => snapshot(options, board, item), close: () => watches.dispose(),
        prepareAnalysis: input => prepareAnalysis(options, input), prepareOperation: async input => prepareAnalysis(options,{...input,...(input.action==='build'?{deployment:await managed?.describe?.(input.item)}:{})}),
        exchange: options.submission ? async (job, observation) => {
            const record = await watch(job);
            return developmentChannelExchange({...options, submission: options.submission!}, {id: job.id, record, service: options.service,
                base: job.request!, observation, targetHead: job.snapshot.targetVersion,
                beforeResume: async () => {requireValue((await snapshot(options, await options.service.read(job.boardId), (await options.service.item(job.boardId, job.itemId)).item)).version === job.snapshot.version, 'MERGE_PLAN_SOURCE_CHANGED');},
                report: (stage, id, code) => journalCommand(options.journal, options.service, job.boardId, 'review-context-log:' + job.id + ':' + stage + ':' + id,
                    {type: 'message', itemId: job.itemId, message: t(('kanban.fileExchange.' + stage) as Parameters<typeof t>[0]) + (code ? ': ' + code : ''), recipientSessionIds: []})});
        } : undefined,
        readOperation: async job => {const value = await readOperation(options, job); if (value !== undefined) await watches.close(job.id); return value;},
        readAnalysis: async job => {const value = await readAnalysis(options, job); if (value !== undefined) await watches.close(job.id); return value;}};
}
async function resource(options: Options, item: KanbanItem, boardId: string): Promise<ReviewResource> {
    const refs = item.externalRefs?.filter(row => row.system === 'nestos-worktree') ?? [];
    const dispatch = Object.values((await options.service.workflow(boardId)).dispatches).filter(row => row.itemId === item.id).sort((a, b) => b.attempt - a.attempt)[0];
    const primary = dispatch ? await options.journal.get<PreparedWorktree>('worktree:' + dispatch.id) : undefined;
    const ref = primary ? {system:'nestos-worktree',id:primary.id} : refs.length === 1 ? refs[0] : undefined;
    requireValue(ref, 'OPERATION_WORKSPACE_REQUIRED');
    const [tree, record, cleanup] = await Promise.all([options.journal.get<PreparedWorktree>('worktree:' + ref.id),
        options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:' + (primary ? dispatch!.id : ref.id)), options.journal.get('worktree-cleanup:' + ref.id)]);
    requireValue(tree && record && !cleanup && tree.directory === record.directory, 'OPERATION_WORKSPACE_UNAVAILABLE');
    requireValue(item.externalRefs?.some(row => row.system === 'nestos-remote-project' && row.id === record.projectId), 'WORKTREE_PROJECT_CHANGED');
    return {id: ref.id, tree, record};
}
async function snapshot(options: Options, board: KanbanBoard, item: KanbanItem): Promise<ReviewSnapshot> {
    const current = await resource(options, item, board.id), {record, tree} = current;
    requireValue((record.context as {board?: {id?: string}; task?: {id?: string}})?.board?.id === board.id
        && (record.context as {task?: {id?: string}})?.task?.id === item.id, 'OPERATION_WORKSPACE_SCOPE_MISMATCH');
    return developmentWorkspace(options.remote, options.provider, record.projectId, async process => {
        const status = await inspectWorktree(process, tree, '_nestos/kanban/'); requireValue(status.exists, 'WORKTREE_MISSING');
        const targetChanges = await gitWorkspace(process, '/workspace', ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=none']);
        const targetWorktree = {dirty:!!targetChanges.stdout.trim(), statusDigest:sha256HexSync(targetChanges.stdout)};
        const repositories = await verifyWorktreeDelivery(process, record.directory, record.repositories, record.policy.commit, record.availableRepositories);
        verifyReadOnlyDelivery(record,repositories,options.runningVersion);
        const {input: _input, ...commitContext} = record.commitContext ?? {};
        const sourceVersion = sha256HexSync(JSON.stringify([record.projectId, tree.id, repositories])), targetVersion = status.targetHead;
        return {sourceVersion, targetVersion, version: sha256HexSync(JSON.stringify([sourceVersion, status.targetBranch, targetVersion])),
            context: {...(record.commitContext ? {commitContext} : {}), commitPolicy: record.policy.commit, projectId: record.projectId, worktreeId: tree.id, directory: tree.directory, branch: tree.branch, sourceHead: status.head,
                targetBranch: status.targetBranch, targetHead: targetVersion, targetWorktree, repositories}};
    });
}
async function prepareAnalysis(options: Options, input: MaintenanceInput): Promise<SubmissionRequest> {
    const current = await resource(options, input.item, input.board.id), calls = await options.calls.list({sessionId: current.id});
    const reasons = await workResourceExecution(options,current.id,current.record.projectId,{purpose:'resume',operationId:input.id}); requireValue(!reasons.length, reasons[0] ?? 'OPERATION_ORIGINAL_SESSION_BUSY');
    const original = calls.find(row => row.receipt.executionSessionId && row.input.request.expectedTarget);
    requireValue(original?.receipt.executionSessionId && calls.every(row => row.callerState?.settled && row.executionTree?.settled), 'OPERATION_ORIGINAL_SESSION_UNAVAILABLE');
    const sessionId = original.receipt.executionSessionId, activity = await options.kernel.sessionActivity(sessionId);
    requireValue(!Object.entries(activity.counts).some(([key, count]) => ['running', 'queued', 'created', 'waiting', 'blocked', 'paused'].includes(key) && count > 0), 'OPERATION_ORIGINAL_SESSION_BUSY');
    const branch = original.input.request.expectedBranch!, catalog = await readContextCatalog(options.kernel, sessionId);
    const bindings = retainedExecutionContexts(Object.values(catalog.value.bindings).filter(row => row.branchId === branch && row.connectionId === 'work-' + current.id));
    requireValue(bindings.length === 1 && bindings[0].validity === 'valid' && !bindings[0].activeOperation, 'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE');
    const binding = bindings[0], target = original.input.request.expectedTarget!, directory = current.record.directory + '/_nestos/kanban/review/' + input.id;
    requireValue(binding.nativeRef?.sessionId,'OPERATION_ORIGINAL_CONTEXT_UNAVAILABLE');
    await freezeAnalysis(options,current,input,sessionId,directory,binding.nativeRef.sessionId);
    return {expectedSessionId: sessionId, expectedBranch: branch, expectedTarget: target, target: {kind: target.kind, id: target.id, version: target.version},
        source: {kind: 'composer', text: !input.action || input.action === 'analyze' ? mergeInstruction(input, directory) : maintenanceInstruction({...input, action: input.action}, directory), attachments: [], values: {}},
        submission: {id: input.id, source: {kind: 'conversation', ownerId: sessionId, id: input.id}},
        overrides: {...original.input.request.overrides, baseRoundId: undefined, newBranchName: undefined, branchMode: 'continue',
            harnessConversation: {mode: 'resume', bindingId: binding.id, expectedBindingRevision: binding.revision, expectedGeneration: binding.generation}}};
}
async function freezeAnalysis(options: Options, current: ReviewResource,
    input: MaintenanceInput, sessionId: string, directory: string,nativeSessionId:string): Promise<void> {
    const folder = await options.projects.get(current.record.projectId), view = await options.projects.openWorkspace(folder.path);
    try {
        const policy = await developmentPolicy(options.journal, options.fs, view.fs, input.id,
            {profile: current.record.policy.profile, commit: current.record.policy.commit, modules: current.record.policy.modules.join(',')});
        const preload = await options.journal.get('merge-context-preload:' + input.id) ?? (!input.action || input.action === 'analyze' ? await developmentWorkspace(options.remote, options.provider, current.record.projectId, process =>
            preloadCommitContexts({...options, record: current.record, process, targetHead: input.snapshot.targetVersion})) : {contexts: [], unresolved: []});
        const context = await options.journal.update('merge-context-preload:' + input.id, old => old ?? preload);
        const contextText = JSON.stringify(context);
        await publishImmutableFile(view.fs, directory, 'commit-contexts.json', contextText);
        const approvalText = input.context === undefined ? undefined : JSON.stringify(input.context);
        if (approvalText) await publishImmutableFile(view.fs, directory, 'operation-input.json', approvalText);
        await publishPromptBundle(view.fs, directory, policy.prompts, {operationId: input.id, phase:input.action??'analyze',...(input.deployment?{deployment:input.deployment}:{}),receiptPath:'_nestos/kanban/review/'+input.id+'/result.json',approval: approvalText ? {path: 'operation-input.json', sha256: sha256HexSync(approvalText)} : null, boardId: input.board.id,
            itemId: input.item.id, sessionId, input: current.record.context, commitContexts: {path: 'commit-contexts.json', sha256: sha256HexSync(contextText)}, sourceVersion: input.snapshot.sourceVersion, targetVersion: input.snapshot.targetVersion, resources: input.snapshot.context});
        await options.journal.update('worktree:' + input.id, old => old ?? current.tree);
        const record = await options.journal.update<DevelopmentWorkspaceRecord>('development-workspace:' + input.id, old => old ?? {...current.record, channelId: input.id, worktreeId: current.id, communicationDirectory: directory, policy,
            context: {...current.record.context as object, operation: {operationId: input.id, phase:input.action??'analyze',...(input.deployment?{deployment:input.deployment}:{}),receiptPath:'_nestos/kanban/review/'+input.id+'/result.json',approval: input.context ?? null,
                sourceVersion: input.snapshot.sourceVersion, targetVersion: input.snapshot.targetVersion, commitContexts: context, resources: input.snapshot.context}}});
        await openDevelopmentChannel(options.remote, input.id, record, {runId: input.id, itemId: input.item.id, attemptId: input.id}, input.item,
            await currentChannelBinding(options.remote,record,nativeSessionId));
    } finally {await view.dispose();}
}
function mergeInstruction(input: {id: string; item: KanbanItem; snapshot: ReviewSnapshot}, _directory: string): string {
    return JSON.stringify({dependencies: {lifecycle: {stage: 'postload.succeeded'}}, operation: {phase: 'merge-analysis', operationId: input.id},
        instruction: `The original development task is terminal. Continue in this SAME Session for READ-ONLY integration analysis; do not rerun development, create another Session or worktree, commit, merge, push, or modify source/main files. `
            + `Read the identity, context and task-merge-pre.md sections through session_context. Context.operation contains frozen commit contexts and approved source/target versions. Compare the retained delivery with the target branch and inspect current target working changes read-only. A dirty target is not itself a conflict. Identify actual overlapping files/modules or functional interactions; unrelated changes must not block this workflow. Preserve all existing user changes. `
            + `Return a plan payload {sourceVersion,targetVersion,summary,conflicts:[{id,path,reason,options:[{id,label,detail}]}]}. Every conflict needs explicit user-selectable alternatives; no choices are approved yet. `
            + `Use exactly sourceVersion ${input.snapshot.sourceVersion} and targetVersion ${input.snapshot.targetVersion}; report changed inputs instead of guessing. `
            + `If context is insufficient use session_request and yield without a final result; the host resumes this SAME Session. Never poll. Read task-merge-post.md through session_context after analysis. `
            + channelResultInstruction,
        task: {id: input.item.id, title: input.item.title, responsibility: input.item.responsibility, acceptance: input.item.acceptance}});
}
async function readAnalysis(options: Options, job: ReviewJob): Promise<unknown | undefined> {
    const board = await options.service.read(job.boardId), item = (await options.service.item(job.boardId, job.itemId)).item;
    requireValue((await snapshot(options, board, item)).version === job.snapshot.version, 'MERGE_PLAN_SOURCE_CHANGED');
    const current = await resource(options, item, board.id);
    return readChannelResult(options.remote, current.record.projectId, job.id, options.journal);
}

async function readOperation(options: Options, job: ReviewJob): Promise<unknown | undefined> {
    if (job.action === 'analyze') return readAnalysis(options, job);
    const board = await options.service.read(job.boardId), item = (await options.service.item(job.boardId, job.itemId)).item;
    const current = await resource(options, item, board.id), folder = await options.projects.get(current.record.projectId), view = await options.projects.openWorkspace(folder.path);
    let result: unknown;
    try {result=await operationReceipt(view.fs,current.record.directory+'/_nestos/kanban/review/'+job.id,await readChannelResult(options.remote,current.record.projectId,job.id,options.journal),options.journal,job.id);
        if (job.action === 'build' && result && (result as {status?: string}).status === 'succeeded') await verifyBuildEvidence(view.fs, current.record.directory, result);}
    finally {await view.dispose();}
    if (result === undefined || ['blocked', 'failed'].includes((result as {status: string})?.status)) return result;
    const actual = await snapshot(options, board, item);
    requireValue(actual.sourceVersion === job.snapshot.sourceVersion, 'OPERATION_RESULT_SOURCE_CHANGED');
    if (job.action !== 'merge') requireValue(actual.version === job.snapshot.version, 'OPERATION_RESULT_SCOPE_MISMATCH');
    else {
        requireValue((result as {targetHead?: string}).targetHead === actual.targetVersion, 'OPERATION_RESULT_MERGE_UNCONFIRMED');
        await developmentWorkspace(options.remote, options.provider, current.record.projectId, async process => {
            requireValue((await gitWorkspace(process, '/workspace', ['merge-base', '--is-ancestor', job.snapshot.targetVersion, actual.targetVersion], true)).code === 0, 'OPERATION_RESULT_TARGET_REWRITTEN');
            const sourceHead=(actual.context as {sourceHead:string}).sourceHead;
            requireValue((await gitWorkspace(process,'/workspace',['merge-base','--is-ancestor',sourceHead,actual.targetVersion],true)).code===0,'OPERATION_RESULT_MERGE_UNCONFIRMED');
        });
    }
    return result;
}

async function verifyBuildEvidence(fs: IFileSystem, directory: string, value: unknown): Promise<void> {
    const evidence = (value as {evidence?: {path?: string; sha256?: string}})?.evidence;
    requireValue(typeof evidence?.path === 'string' && evidence.path.length <= 512 && evidence.path.split('/').every(part => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')
        && (!evidence.path.startsWith('_nestos/kanban/')||evidence.path.startsWith('_nestos/kanban/artifacts/')) && typeof evidence.sha256 === 'string' && /^[a-f0-9]{64}$/.test(evidence.sha256), 'OPERATION_RESULT_ARTIFACT_UNVERIFIED');
    await verifyFileDigest(fs, directory + '/' + evidence.path, evidence.sha256, 8 * 1024 * 1024, (value as {operationId?: string}).operationId);
}

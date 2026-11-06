import {automaticDelivery,automaticDeliveryStatus} from './automatic-delivery';
import {safeCode} from '@nestos/kanban/integration';
import {sha256HexSync, t} from '@nestos/common';
import type {KanbanItemOperations, KanbanItemOperation, KanbanItemOperationRequest, KanbanItemOperationBinding, KanbanBoard, KanbanItem, KanbanSessionAssociation} from '@nestos/kanban/contracts';
import {automationTarget, automationCatalog} from './automation-targets';
import {requireValue} from './validation';
import {prepareReviewJob, advanceReviewJob} from './item-operation-jobs';
import {reviewKey, jobKey, type ReviewJob, type ReviewSettings, type ReviewOperationsOptions, type ReviewAction, type MergePlan} from './item-operation-types';

const actions: ReviewAction[] = ['build', 'deploy', 'accept', 'analyze', 'merge'];
const initial = (): ReviewSettings => ({revision: 0, bindings: {}, jobs: [], receipts: {}});
interface Context {deliveryPlan?:import('./item-operation-types').DeliveryPlan;board: KanbanBoard; item: KanbanItem; archived: boolean; settings: ReviewSettings; jobs: ReviewJob[]}
export function createItemOperations(options: ReviewOperationsOptions) {
    let stopped = false; const tails = new Map<string, Promise<unknown>>();
    const queue = <T>(board: string, item: string, work: () => Promise<T>): Promise<T> => {
        requireValue(!stopped, 'SERVICE_STOPPING'); const key = reviewKey(board, item);
        const pending = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {requireValue(!stopped, 'SERVICE_STOPPING'); return work();}); tails.set(key, pending);
        void pending.finally(() => {if (tails.get(key) === pending) tails.delete(key);}).catch(() => {}); return pending;
    };
    const automatic=automaticDelivery({...options,target:options.automaticTarget,plan:options.deliveryPlan,active:()=>!stopped,report:options.reportAutomatic,view:(board,item)=>queue(board,item,async()=>view(options,await load(options,board,item,true))),run:(board,request)=>queue(board,request.itemId,()=>run(options,board,request,true))});
    return {deliveryReady:automatic.ready,itemOperations: (board: string, item: string) => queue(board, item, async () => view(options, await load(options, board, item, true))),
        bindItemOperation: (board: string, request: KanbanItemOperationBinding) => {validateRequest(request); return queue(board, request.itemId, () => bind(options, board, request));},
        runItemOperation: (board: string, request: KanbanItemOperationRequest) => {validateRequest(request); return queue(board, request.itemId, () => run(options, board, request));},
        async scan() {
            for (const scope of await options.journal.get<Array<{board: string; item: string}>>('review-operation-scopes') ?? []) {
                if (stopped) return;
                await queue(scope.board, scope.item, async () => {const context = await load(options, scope.board, scope.item, false);
                    for (const job of context.jobs) {if (stopped) return; if (job.phase !== 'settled') {if(job.phase==='prepared'&&(await options.service.read(scope.board)).executionControl?.paused)continue;await advanceReviewJob(options, job);} else await options.report?.(job);}
                    if(!stopped)await followUp(options,scope.board,scope.item);});
            }
            if(!stopped)await automatic.scan();
        },
        guardResource: <T>(board: string, item: string, work: () => Promise<T>) => queue(board, item, async () => {
            requireValue(!(await load(options, board, item, false)).jobs.some(job => job.phase !== 'settled'), 'WORKTREE_IN_USE');
            return work();
        }),
        async sessions(board: string, item: string): Promise<KanbanSessionAssociation[]> {
            const context = await load(options, board, item, false);
            return context.jobs.filter(job => job.sessionId).map(job => ({sessionId: job.sessionId!, purpose: job.action === 'analyze' ? 'execution' : 'finalization',
                execution: {id: job.id, purpose: job.action === 'analyze' ? 'execution' : 'finalization', state: job.state === 'succeeded' ? 'completed' : job.state, code: job.code, createdAt: job.createdAt}}));
        },
        async quiesce() {stopped = true; await Promise.allSettled([...tails.values()]); await options.adapter.close?.(); await options.journal.drain();}};
}
async function load(options: ReviewOperationsOptions, board: string, item: string, observe: boolean): Promise<Context> {
    const [definition, entry, saved] = await Promise.all([options.service.read(board), options.service.item(board, item), options.journal.get<ReviewSettings>(reviewKey(board, item))]);
    const settings = saved ?? initial(), jobs: ReviewJob[] = [];
    for (const id of settings.jobs) {let job = await options.journal.get<ReviewJob>(jobKey(id)); if (!job) continue;
        requireValue(job.boardId === board && job.itemId === item, 'OPERATION_SCOPE_MISMATCH');
        if (observe && job.phase === 'submitting') job = await advanceReviewJob(options, job); jobs.push(job);}
    return {deliveryPlan:await options.deliveryPlan?.(definition,entry.item),board: definition, item: entry.item, archived: !!entry.archive, settings, jobs};
}
const latest = (context: Context, action: ReviewAction) => context.jobs.filter(job => job.action === action).at(-1);
function revision(context: Context): string {return sha256HexSync(JSON.stringify([context.settings.revision, context.item.revision, context.jobs.map(job => [job.id, job.phase, job.state, job.code,job.result,job.followUp?.state,job.followUp?.code])]));}
async function view(options: ReviewOperationsOptions, context: Context): Promise<KanbanItemOperations> {
    if (context.archived || options.adapter.supports?.(context.board, context.item) === false) return {revision: revision(context), operations: []};
    const active = context.jobs.some(job => job.phase !== 'settled'), supported = ['review', 'completed'].includes(context.item.status);
    const operations = await Promise.all(actions.map(async action => {
        const entry = operation(context, action, active, supported, !!options.adapter.prepareOperation);
        if (context.board.lifecycle && action !== 'accept') {entry.enabled=false;entry.reason=t('kanban.errors.BOARD_STOPPING');}
        if (entry.sessionId) entry.sessionId = await options.sessionResource?.(entry.sessionId) ?? entry.sessionId;
        return entry;
    }));
    const automatic=await automaticDeliveryStatus(options.journal,context.board.id,context.item.id);
    if(options.adapter.prepareOperation)return {revision:revision(context),operations:operations.filter(op=>!context.deliveryPlan||context.deliveryPlan.steps.includes(op.id)),automatic};
    const catalog = await options.catalog(), flows = catalog.entries.filter(entry => entry.target.kind === 'flow' && entry.input?.parameters.some(parameter => parameter.name === 'context' && parameter.type === 'string'));
    return {revision: revision(context),operations:operations.filter(op=>!context.deliveryPlan||context.deliveryPlan.steps.includes(op.id)),automatic,targets: automationCatalog({...catalog, entries: flows}).targets};
}
function acceptsAfterMerge(context:Context):boolean {const steps=context.deliveryPlan?.steps;return !!steps&&steps.indexOf('merge')>=0&&steps.indexOf('merge')<steps.indexOf('accept');}
function mergePrerequisite(context:Context):boolean {
    if(context.item.status==='completed')return true;
    if(!acceptsAfterMerge(context)||context.item.status!=='review')return false;
    return context.deliveryPlan?.acceptance!=='runtime'||latest(context,'deploy')?.state==='succeeded';
}
function operation(context: Context, action: ReviewAction, active: boolean, supported: boolean, agent = false): KanbanItemOperation {
    const job = latest(context, action), binding = context.settings.bindings[action], plan = latest(context, 'analyze')?.result as MergePlan | undefined;
    const ready = action === 'build' || action === 'analyze' || action === 'deploy' && latest(context, 'build')?.state === 'succeeded'
        || action === 'accept' && (acceptsAfterMerge(context)?latest(context,'merge')?.state==='succeeded':context.deliveryPlan?.acceptance==='source'||latest(context, 'deploy')?.state === 'succeeded') && context.item.status === 'review'
        || action === 'merge' && !!plan && latest(context, 'analyze')?.state === 'succeeded' && mergePrerequisite(context);
    const configurable = !agent && ['build', 'deploy', 'merge'].includes(action), finished = action === 'accept' && context.item.status === 'completed' || action === 'merge' && job?.state === 'succeeded';
    const enabled = (!context.deliveryPlan||context.deliveryPlan.steps.includes(action)) && supported && !context.archived && !finished && !active && ready && (!configurable || !!binding);
    const built=latest(context,'build'),auto=built?.followUp,autoPending=action==='deploy'&&auto?.state==='queued'&&built?.state==='succeeded'&&(!job||job.createdAt<built.createdAt);
    return {...(action==='build'?{runLabel:job?.state==='succeeded'?t('kanban.operationRebuild'):undefined,followUp:{action:'deploy',label:t('kanban.operationAutoDeploy'),confirmation:t('kanban.operationConfirmDeploy')}}:{}),...(action==='deploy'?{hideRun:!!auto&&auto.state!=='failed'&&!(job&&job.createdAt>=(built?.createdAt??0)&&job.state==='failed')}:{}),id: action, label: action==='accept'&&context.deliveryPlan?.acceptanceLabel||t(('kanban.operationAction.' + action) as Parameters<typeof t>[0]),
        state:autoPending?'running':action==='deploy'&&auto?.state==='failed'?'failed':action === 'accept' && context.item.status === 'completed' ? 'succeeded' : job?.phase !== undefined && job.phase !== 'settled' ? job.state : job?.state ?? (enabled ? action === 'accept' || action === 'merge' ? 'waiting-confirmation' : 'ready' : 'unavailable'), enabled,
        code:action==='deploy'&&auto?.state==='failed'?auto.code:job?.code==='WORKSPACE_CONTEXT_PENDING'?undefined:job?.code, runId: job?.id, sessionId: job?.sessionId, configurable, binding, openSessionOnRun: agent || action === 'analyze',
        reason: job?.code === 'WORKSPACE_CONTEXT_PENDING' ? t('kanban.contextPending') : enabled || finished ? undefined : t(!supported ? 'kanban.operationNeedsDelivery' : active ? 'kanban.operationBusy' : configurable && !binding ? 'kanban.operationNeedsFlow' : 'kanban.operationNeedsPrevious'),
        summary: (action === 'analyze' || action === 'merge') && plan ? plan.summary + '\n' + t('kanban.operationVersions', {source: plan.sourceVersion, target: plan.targetVersion}) : resultSummary(job?.result),
        fields: action === 'merge' && plan ? plan.conflicts.map(conflict => ({id: conflict.id, label: conflict.path + ' · ' + conflict.reason, choices: conflict.options})) : undefined,
        confirmation: action === 'deploy' ? t('kanban.operationConfirmDeploy') : action === 'accept' ? context.deliveryPlan?.acceptanceConfirmation??t('kanban.operationConfirmAcceptance') : action === 'merge' ? t('kanban.operationConfirmMerge') : undefined};
}
function resultSummary(result: unknown): string | undefined {
    const value = result as {summary?: string; version?: string} | undefined;
    return [typeof value?.summary === 'string' ? value.summary.slice(0, 8000) : undefined, typeof value?.version === 'string' ? t('kanban.operationVersion', {version: value.version}) : undefined].filter(Boolean).join('\n') || undefined;
}
async function authorize(options: ReviewOperationsOptions, context: Context): Promise<void> {
    const actor = await options.service.currentPrincipal();
    requireValue(actor.kind === 'human' && context.board.members?.some(member => member.kind === actor.kind && member.id === actor.id
        && member.roles?.includes('coordinator')), 'OPERATION_COORDINATOR_REQUIRED');
}
async function bind(options: ReviewOperationsOptions, board: string, request: KanbanItemOperationBinding) {
    const context = await load(options, board, request.itemId, true); await authorize(options, context);
    requireValue(!context.board.lifecycle || request.action === 'accept','BOARD_STOPPING');
    requireValue(context.item.deletedAt === undefined && context.item.control?.action !== 'cancel', 'TASK_CANCELLING');
    requireValue(['build', 'deploy', 'merge'].includes(request.action), 'OPERATION_BINDING_FORBIDDEN');
    requireValue(!context.jobs.some(job => job.phase !== 'settled'), 'OPERATION_IN_USE');
    const catalog = await options.catalog(), target = automationTarget(request.target, catalog); requireValue(target.kind === 'flow', 'OPERATION_FLOW_REQUIRED');
    requireValue(catalog.entries.find(entry => entry.target.digest === target.digest && entry.target.id === target.id)?.input?.parameters.some(parameter => parameter.name === 'context' && parameter.type === 'string'), 'OPERATION_FLOW_CONTEXT_REQUIRED');
    const digest = sha256HexSync(JSON.stringify(request));
    await options.journal.update<ReviewSettings>(reviewKey(board, request.itemId), old => {
        const saved = old ?? initial(); if (Object.hasOwn(saved.receipts, request.operationId)) {requireValue(saved.receipts[request.operationId] === digest, 'IDEMPOTENCY_CONFLICT'); return saved;}
        requireValue(request.expectedRevision === revision(context) && saved.revision === context.settings.revision, 'OPERATION_STALE_REFRESH');
        requireValue(Object.keys(saved.receipts).length < 256, 'OPERATION_HISTORY_LIMIT');
        return {...saved, revision: saved.revision + 1, bindings: {...saved.bindings, [request.action]: request.target}, receipts: {...saved.receipts, [request.operationId]: digest}};
    });
    return view(options, await load(options, board, request.itemId, false));
}
async function run(options: ReviewOperationsOptions, board: string, request: KanbanItemOperationRequest, automatic=false): Promise<KanbanItemOperations> {
    const context = await load(options, board, request.itemId, true); await authorize(options, context);
    if(automatic)requireValue(!context.board.executionControl?.paused,'AUTOMATIC_DELIVERY_PAUSED');
    requireValue(!context.board.lifecycle || request.action === 'accept','BOARD_STOPPING');
    requireValue(context.item.deletedAt === undefined && context.item.control?.action !== 'cancel', 'TASK_CANCELLING');
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && actions.includes(request.action as ReviewAction), 'OPERATION_REQUEST_INVALID');
    const prior = await options.journal.get<ReviewJob>(jobKey(request.operationId));
    requireValue(!prior || prior.boardId === board && prior.itemId === request.itemId && prior.fingerprint === sha256HexSync(JSON.stringify(request)), 'IDEMPOTENCY_CONFLICT');
    if (prior && context.settings.jobs.includes(prior.id)) {requireValue(prior.fingerprint === sha256HexSync(JSON.stringify(request)), 'IDEMPOTENCY_CONFLICT'); return view(options, context);}
    requireValue(request.expectedRevision === revision(context), 'OPERATION_STALE_REFRESH');
    const entry = operation(context, request.action as ReviewAction, context.jobs.some(job => job.phase !== 'settled'), options.adapter.supports?.(context.board, context.item) !== false && ['review', 'completed'].includes(context.item.status), !!options.adapter.prepareOperation);
    requireValue(entry.enabled, 'OPERATION_PREREQUISITE_REQUIRED');
    if (entry.confirmation) requireValue(request.confirmed === true, 'OPERATION_CONFIRMATION_REQUIRED');
    requireValue(request.followUp===undefined||request.action==='build'&&request.followUp==='deploy','OPERATION_REQUEST_INVALID');
    const input = await operationInput(options, context, request), job = prior ?? (request.action === 'accept' ? await acceptanceJob(options, context, request)
        : await prepareReviewJob(options, context.board, context.item, context.settings, request, input));
    await options.journal.update<Array<{board: string; item: string}>>('review-operation-scopes', old => old?.some(row => row.board === board && row.item === request.itemId) ? old : [...old ?? [], {board, item: request.itemId}]);
    await options.journal.update<ReviewJob>(jobKey(job.id), old => {requireValue(!old || old.fingerprint === job.fingerprint, 'IDEMPOTENCY_CONFLICT'); return old ?? job;});
    await options.journal.update<ReviewSettings>(reviewKey(board, request.itemId), old => {
        const saved = old ?? initial(); requireValue(saved.revision === context.settings.revision, 'OPERATION_STALE_REFRESH'); requireValue(saved.jobs.length < 64, 'OPERATION_HISTORY_LIMIT');
        return {...saved, revision: saved.revision + 1, jobs: [...saved.jobs, job.id]};
    });
    await options.report?.(job); if(!automatic||!(await options.service.read(board)).executionControl?.paused)await advanceReviewJob(options,job);if(request.action==='build')await followUp(options,board,request.itemId);return view(options,await load(options,board,request.itemId,false));
}
async function operationInput(options: ReviewOperationsOptions, context: Context, request: KanbanItemOperationRequest): Promise<unknown> {
    if (request.action === 'deploy') {
        const built = latest(context, 'build')!, snapshot = await options.adapter.snapshot(context.board, context.item);
        requireValue(snapshot.version === built.snapshot.version, 'OPERATION_SOURCE_CHANGED_REBUILD'); return built.result;
    }
    if (request.action !== 'merge') return;
    const analysis = latest(context, 'analyze')!, plan = analysis.result as MergePlan, selections = request.selections ?? {};
    requireValue(Object.keys(selections).length === plan.conflicts.length && plan.conflicts.every(conflict => Object.hasOwn(selections, conflict.id) && conflict.options.some(option => option.id === selections[conflict.id])), 'OPERATION_SELECTION_REQUIRED');
    if(acceptsAfterMerge(context)&&context.deliveryPlan?.acceptance==='runtime')requireValue(options.adapter.runningVersion?.()===(latest(context,'deploy')?.result as {version?:string})?.version,'OPERATION_RUNNING_VERSION_MISMATCH');
    const current = await options.adapter.snapshot(context.board, context.item);
    requireValue(current.version === analysis.snapshot.version, 'OPERATION_SOURCE_CHANGED_REANALYZE');
    return {approvalId: request.operationId, analysisId: analysis.id, analysisDigest: sha256HexSync(JSON.stringify(plan)),
        sourceVersion: current.sourceVersion, targetVersion: current.targetVersion, selections, plan};
}
async function acceptanceJob(options: ReviewOperationsOptions, context: Context, request: KanbanItemOperationRequest): Promise<ReviewJob> {
    const deployed = latest(context, 'deploy'), snapshot = await options.adapter.snapshot(context.board, context.item),scope=context.deliveryPlan?.acceptance??'runtime';
    let version:string|undefined;
    if(scope==='runtime'){
        requireValue(deployed&&snapshot.sourceVersion===deployed.snapshot.sourceVersion,'OPERATION_SOURCE_CHANGED_REBUILD');
        requireValue(acceptsAfterMerge(context)?snapshot.targetVersion===(latest(context,'merge')?.result as {targetHead?:string})?.targetHead:snapshot.version===deployed.snapshot.version,'OPERATION_SOURCE_CHANGED_REBUILD');
        version=(deployed.result as {version:string}).version;
        requireValue(options.adapter.runningVersion?.() === version, 'OPERATION_RUNNING_VERSION_MISMATCH');
    }
    const workflow = await options.service.workflow(context.board.id), dispatch = Object.values(workflow.dispatches).filter(row => row.itemId === context.item.id).sort((a, b) => b.attempt - a.attempt)[0];
    requireValue(dispatch?.outcome === 'succeeded', 'OPERATION_ACCEPTANCE_UNAVAILABLE');
    return {id: request.operationId, boardId: context.board.id, itemId: context.item.id, action: 'accept', phase: 'prepared', state: 'running',
        fingerprint: sha256HexSync(JSON.stringify(request)), snapshot, createdAt: Date.now(), acceptanceVersion: version,acceptanceScope:scope,
        command: {type: 'accept-execution', dispatchId: dispatch.id, accept: true}};
}

function validateRequest(request: KanbanItemOperationRequest | KanbanItemOperationBinding): void {
    requireValue(request && typeof request === 'object' && typeof request.itemId === 'string' && request.itemId.length > 0 && request.itemId.length <= 256
        && typeof request.operationId === 'string' && /^[\w-]{1,128}$/.test(request.operationId) && !['__proto__', 'constructor', 'prototype'].includes(request.operationId)
        && actions.includes(request.action as ReviewAction) && typeof request.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(request.expectedRevision), 'OPERATION_REQUEST_INVALID');
    if('followUp' in request&&request.followUp!==undefined)requireValue(request.action==='build'&&request.followUp==='deploy','OPERATION_REQUEST_INVALID');
    if ('selections' in request && request.selections !== undefined) requireValue(request.selections && typeof request.selections === 'object'
        && !Array.isArray(request.selections) && Object.keys(request.selections).length <= 100
        && Object.values(request.selections).every(value => typeof value === 'string' && value.length <= 128), 'OPERATION_REQUEST_INVALID');
    if ('target' in request) requireValue(request.target && typeof request.target.system === 'string' && typeof request.target.id === 'string'
        && typeof request.target.revision === 'string', 'OPERATION_REQUEST_INVALID');
}

/** The user's build-time approval is frozen; restart resumes this exact replacement request. */
async function followUp(options:ReviewOperationsOptions,board:string,item:string):Promise<void> {
    const started=Date.now(),context=await load(options,board,item,false),build=latest(context,'build');
    if(context.board.executionControl?.paused||context.board.lifecycle||context.item.deletedAt||context.item.control?.action==='cancel')return;
    if(build?.state!=='succeeded'||build.phase!=='settled'||build.followUp?.state!=='queued')return;
    const id='deploy-'+sha256HexSync(build.id).slice(0,48),deployed=latest(context,'deploy');
    if(deployed&&deployed.createdAt>=build.createdAt){await markFollowUp(options,build,'started');return;}
    if(context.jobs.some(job=>job.phase!=='settled'))return;
    const request=build.followUp.request??{operationId:id,itemId:item,action:'deploy',expectedRevision:revision(context),confirmed:true};
    await options.journal.update<ReviewJob>(jobKey(build.id),old=>({...old!,followUp:{...old!.followUp!,request:old!.followUp!.request??request}}));
    try{await run(options,board,request,true);await markFollowUp(options,build,'started');}
    catch(error){
        if(await options.journal.get<ReviewJob>(jobKey(id)))return;
        const code=safeCode(error,'OPERATION_AUTO_DEPLOY_FAILED');if(code==='AUTOMATIC_DELIVERY_PAUSED')return;await markFollowUp(options,build,'failed',code);
        options.log({operationId:id,stage:'operation.auto-deploy.prepare',result:'failure',code,durationMs:Date.now()-started});
    }
}
async function markFollowUp(options:ReviewOperationsOptions,build:ReviewJob,state:'started'|'failed',code?:string) {
    await options.journal.update<ReviewJob>(jobKey(build.id),old=>({...old!,followUp:{...old!.followUp!,state,code}}));
}

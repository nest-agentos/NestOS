import {developmentAnalysisPolicy,developmentAuthority} from './development-operation-policy';
import {developmentDeliveryPolicy,releasableDevelopmentTarget} from './development-operation-policy';
import {requireOperationAuthority,type OperationOrigin} from '@nestos/kanban/integration';
import {operation,latestReviewJob as latest} from './item-operation-projection';
import type {ReviewContext as Context} from './item-operation-types';
import {discoverOperationScopes} from './item-operation-discovery';
import {scanRetiredScope} from './item-operation-retirement';
import {invalidateReviewAnalysis,prepareAutomaticReanalysis} from '@nestos/kanban/integration';
import {readOperationScopes,operationRequestOptions,scopedOperationOptions,scopedFinalizationStatus} from './item-operation-scopes';
import {finishReviewCleanup,reviewCleanupKey,type ReviewCleanup} from '@nestos/kanban/integration';
import {cancellationKey,pendingCancellation,cancellationSupported,requestCancellation,scanCancellations,type ReviewCancellation} from '@nestos/kanban/integration';
import {operationDependencies,operationGroup,affectedOperations,effectiveOperationWaivers,projectOperationSkips,skipItemOperations,applySkipIntent} from './item-operation-skips';
import {automaticDelivery,automaticDeliveryStatus} from '@nestos/kanban/integration';
import {safeCode,journalCommand} from '@nestos/kanban/integration';
import {sha256HexSync, t} from '@nestos/common';
import type {KanbanItemOperations, KanbanItemOperation, KanbanItemOperationRequest, KanbanItemOperationBinding, KanbanItem, KanbanSessionAssociation} from '@nestos/kanban/contracts';
import {automationTarget, automationCatalog} from './automation-targets';
import {requireValue} from './validation';
import {prepareReviewJob, advanceReviewJob} from './item-operation-jobs';
import { type ReviewJob, type ReviewSettings, type ReviewOperationsOptions, type ReviewAction, type MergePlan} from './item-operation-types';
import {reviewKey, jobKey} from '@nestos/kanban/integration';

const actions: ReviewAction[] = ['build', 'deploy', 'accept', 'analyze', 'merge'];
const initial = (): ReviewSettings => ({revision: 0, bindings: {}, jobs: [], receipts: {}});

export function createItemOperations(input: ReviewOperationsOptions) {
    const options=input;options.uncancellableActions??=['accept'];
    let stopped = false; const tails = new Map<string, Promise<unknown>>();
    const queue = <T>(board: string, item: string, work: () => Promise<T>, lane='run'): Promise<T> => {
        requireValue(!stopped, 'SERVICE_STOPPING'); const key = JSON.stringify([board,item,lane]);
        const pending = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {requireValue(!stopped, 'SERVICE_STOPPING'); return work();}); tails.set(key, pending);
        void pending.finally(() => {if (tails.get(key) === pending) tails.delete(key);}).catch(() => {}); return pending;
    };
    const read=(board:string,item:string)=>readOperationScopes(options,board,item,scoped=>load(scoped,board,item,false).then(context=>view(scoped,context)));
    const write=async(board:string,request:KanbanItemOperationRequest|KanbanItemOperationBinding,work:(scoped:ReviewOperationsOptions)=>Promise<KanbanItemOperations>)=>{
        const result=await work(await operationRequestOptions(options,board,request));
        return request.scopeId?read(board,request.itemId):result;
    };
    const createAutomatic=(scoped:ReviewOperationsOptions)=>automaticDelivery({...scoped,policy:developmentDeliveryPolicy,releasableTarget:(scope,state)=>releasableDevelopmentTarget(options,scope,state),handoff:scoped.scopes?.handoff,
        automatic:scoped.automatic||scoped.scopes?.handoff?async(board,item)=>{
            const route=await scoped.scopes?.describe(board.id,item.id);
            if(route?.owner&&scoped.scopes?.handoff)return true;
            const scopes=route?.scopes;return (!scopes||scopes.length>0&&scopes.every(scope=>scope.completed))&&!!await scoped.automatic?.(board,item);
        }:undefined,
        reanalysis:(board,item,id)=>queue(board,item,()=>prepareAutomaticReanalysis({...scoped,policy:developmentAnalysisPolicy},board,item,id)),
        settle:(board,item)=>settleDeliveryAcceptance(scoped,board,item),
        target:scoped.automaticTarget,plan:scoped.deliveryPlan,cleanup:(board,item,id)=>cleanupAfterSubmission(scoped,board,item,id),active:()=>!stopped,
        report:scoped.reportAutomatic,retryPrecondition:(board,item,action,code)=>recoverAcceptancePrecondition(scoped,board,item,action,code),
        view:(board,item)=>queue(board,item,async()=>view(scoped,await load(scoped,board,item,true))),run:(board,request)=>queue(board,request.itemId,()=>run(scoped,board,request,'automatic'))});
    const automatic=createAutomatic(options);
    const contexts=async(board:string,item:string)=>{
        const route=await options.scopes?.describe(board,item),scopes=route?.scopes??[];
        return Promise.all([load(options,board,item,false),...scopes.map(async scope=>load(await scopedOperationOptions(options,board,item,scope.id),board,item,false))]);
    };
    return {applies:(board:import('@nestos/kanban/contracts').KanbanBoard,item:KanbanItem)=>options.adapter.supports?.(board,item)!==false,finalizationStatus:(board:string,item:string)=>scopedFinalizationStatus(options,board,item),deliveryReady:async(board:string,item:KanbanItem)=>options.adapter.supports?.(await options.service.read(board),item)===false?true:(await options.scopes?.dependencyReady?.(board,item))??automatic.ready(board,item),itemOperations: (board: string, item: string) => {
        requireValue(!stopped, 'SERVICE_STOPPING');
        return read(board,item);
    },
        bindItemOperation: (board: string, request: KanbanItemOperationBinding) => {validateRequest(request); return queue(board, request.itemId,()=>write(board,request,scoped=>bind(scoped,board,request)));},
        runItemOperation: (board: string, request: KanbanItemOperationRequest) => {validateRequest(request); return queue(board, request.itemId,()=>write(board,request,scoped=>run(scoped,board,request)),request.action==='cancel'?'cancel':'run');},
        async scan() {
            await scanCancellations(options,()=>!stopped);
            for(const intent of await options.journal.get<Array<{key:string;board:string}>>('review-skip-intents')??[]){if(stopped)return;try{await applySkipIntent(options,intent.key,intent.board);}catch{/* The frozen intent retains its failure; other scopes must continue. */}}
            const registered=await options.journal.get<Array<{board:string;item:string;scopeId?:string}>>('review-operation-scopes')??[];
            for (const scope of registered) {
                if (stopped) return;
                const started=Date.now();let archived=false;try{
                await queue(scope.board, scope.item, async () => {if(await scanRetiredScope(options,scope,advanceReviewJob)){archived=true;return;}const scoped=await scopedOperationOptions(options,scope.board,scope.item,scope.scopeId);const context = await load(scoped, scope.board, scope.item, false);
                    for (const job of context.jobs) {if (stopped) return; if (job.phase !== 'settled') {if(job.phase==='prepared'&&(await options.service.read(scope.board)).executionControl?.paused)continue;await advanceReviewJob(scoped, job);} else await scoped.report?.(job);}
                    if(!stopped){await followUp(scoped,scope.board,scope.item);await settleDeliveryAcceptance(scoped,scope.board,scope.item);}});
                if(!stopped&&!archived&&scope.scopeId){const scoped=await scopedOperationOptions(options,scope.board,scope.item,scope.scopeId);await createAutomatic(scoped).scanScope(scope.board,scope.item);}
                }catch(error){options.log({operationId:scope.scopeId??scope.item,stage:'operation.scope.scan',result:'failure',code:safeCode(error,'OPERATION_OBSERVATION_FAILED'),durationMs:Date.now()-started});}
            }
            await discoverOperationScopes(options,registered,()=>!stopped,(scoped,board,item)=>createAutomatic(scoped).scanScope(board,item));
            if(!stopped)await automatic.scan();
        },
        guardResource: <T>(board: string, item: string, work: () => Promise<T>) => queue(board, item, async () => {
            requireValue(!(await contexts(board,item)).some(context=>context.jobs.some(job => job.phase !== 'settled')), 'WORKTREE_IN_USE');
            return work();
        }),
        async sessions(board: string, item: string): Promise<KanbanSessionAssociation[]> {
            const jobs=(await contexts(board,item)).flatMap(context=>context.jobs);
            return jobs.filter(job => job.sessionId).map(job => ({sessionId: job.sessionId!, purpose: job.action === 'analyze' ? 'execution' : 'finalization',
                execution: {id: job.id, purpose: job.action === 'analyze' ? 'execution' : 'finalization', state:job.code==='OPERATION_CANCELLED'?'cancelled':job.state === 'succeeded' ? 'completed' : job.state, code: job.code, createdAt: job.createdAt}}));
        },
        async quiesce() {stopped = true; await Promise.allSettled([...tails.values()]); await options.adapter.close?.();await options.scopes?.close?.(); await options.journal.drain();}};
}
async function load(options: ReviewOperationsOptions, board: string, item: string, observe: boolean): Promise<Context> {
    const [definition, entry, saved, cleanup] = await Promise.all([options.service.read(board), options.service.item(board, item), options.journal.get<ReviewSettings>(reviewKey(board, item,options.scopeId)),options.journal.get<ReviewCleanup>(reviewCleanupKey(board,item,options.scopeId))]);
    const settings = saved ?? initial(), jobs: ReviewJob[] = [];
    for (const id of settings.jobs) {let job = await options.journal.get<ReviewJob>(jobKey(id)); if (!job) continue;
        requireValue(job.boardId === board && job.itemId === item&&job.scopeId===options.scopeId, 'OPERATION_SCOPE_MISMATCH');
        if (observe && job.phase === 'submitting') job = await advanceReviewJob(options, job); jobs.push(job);}
    const cancellations=(await options.journal.getMany<ReviewCancellation>(jobs.map(job=>cancellationKey(job.id)))).filter((row):row is ReviewCancellation=>!!row);
    requireValue(cancellations.every(row=>row.boardId===board&&row.itemId===item&&jobs.some(job=>job.id===row.runId)),'OPERATION_SCOPE_MISMATCH');
    return {scoped:!!options.scopeId,cleanup,cancellations,deliveryPlan:await options.deliveryPlan?.(definition,entry.item),board: definition, item: entry.item, archived: !!entry.archive, settings, jobs};
}
function revision(context: Context): string {return sha256HexSync(JSON.stringify([context.settings.revision, context.item.revision,context.cleanup,context.deliveryPlan,context.cancellations, context.jobs.map(job => [job.id, job.phase, job.state, job.code,job.result,job.followUp?.state,job.followUp?.code])]));}
async function view(options: ReviewOperationsOptions, context: Context): Promise<KanbanItemOperations> {
    if (context.archived || options.adapter.supports?.(context.board, context.item) === false) return {revision: revision(context), operations: []};
    const active = context.jobs.some(job => job.phase !== 'settled')||context.cancellations.some(pendingCancellation), supported = options.adapter.ready?.(context.board,context.item)??['review', 'completed'].includes(context.item.status);
    const activeWaivers=await currentWaivers(options,context);
    const related=await options.adapter.relatedSession?.(context.board,context.item),sessionResources=new Map<string,Promise<string|undefined>>();
    const raw = await Promise.all(actions.map(async action => {
        const entry = cancellationView(options,context,operation(context, action, active, supported, !!options.adapter.prepareOperation,activeWaivers));
        if (context.board.lifecycle && action !== 'accept') {entry.enabled=false;entry.reason=t('kanban.errors.BOARD_STOPPING');}
        entry.sessionId??=related;
        if(entry.sessionId&&options.sessionResource){const id=entry.sessionId;let resource=sessionResources.get(id);if(!resource){resource=options.sessionResource(id);sessionResources.set(id,resource);}entry.sessionId=await resource??id;}
        return entry;
    }));
    const selected=raw.filter(op=>!context.deliveryPlan||context.deliveryPlan.steps.includes(op.id)||context.jobs.some(job=>job.action===op.id&&job.phase!=='settled'));
    if(context.deliveryPlan?.ordering==='configured'){const order=context.deliveryPlan.steps;selected.sort((left,right)=>order.indexOf(left.id)-order.indexOf(right.id));}
    const actor=await options.service.currentPrincipal(),canSkip=!options.scopeId&&actor.kind==='human'&&context.board.members?.some(row=>row.kind===actor.kind&&row.id===actor.id&&row.roles?.includes('coordinator'));
    const projected=projectOperationSkips(cancelDependentOperations(context,selected),context.deliveryPlan,activeWaivers,!!canSkip&&supported&&!active&&!context.board.lifecycle&&!context.item.deletedAt&&context.item.control?.action!=='cancel').map(entry=>canSkip||!entry.cancel?entry:{...entry,cancel:{...entry.cancel,enabled:false,reason:t('kanban.errors.OPERATION_COORDINATOR_REQUIRED')}});
    const operations=projected.map(entry=>{
        const cleanup=context.cleanup,merged=latest(context,'merge');
        if(entry.id==='merge'&&cleanup&&merged&&cleanup.runId===merged.id&&cleanup.state!=='succeeded')return {...entry,group:operationGroup(entry.id),label:t('kanban.operationCleanup'),state:cleanup.state==='failed'?'failed' as const:'running' as const,
            code:cleanup.code,progress:cleanup.state==='running'?{stage:'running' as const,label:t('kanban.operationProgress.cleanup')}:undefined,runAction:'cleanup',runLabel:t('kanban.operationRetryCleanup'),confirmation:undefined,
            enabled:cleanup.state==='failed'&&!active,cancel:undefined,fields:undefined,skip:undefined};
        return {...entry,group:operationGroup(entry.id)};
    });
    const halted=operationHalt(context,activeWaivers);
    const audit={...(context.settings.invalidatedAnalysis?{code:context.settings.invalidatedAnalysis.code}:{}),...(halted?{halted:{runId:halted.runId,state:halted.state==='cancelled'?'cancelled' as const:'cancelling' as const}}:{}),waivers:activeWaivers,waiverHistory:context.item.operationWaivers,acceptance:context.item.acceptanceResult,skippedActions:[...new Set(activeWaivers.flatMap(row=>row.operations.map(op=>op.id)))].filter(id=>{const entry=operations.find(row=>row.id===id);return entry?entry.state==='skipped':!active;})};
    const automatic=await automaticDeliveryStatus(options.journal,context.board.id,context.item.id,options.scopeId,developmentDeliveryPolicy.steps);
    if(options.adapter.prepareOperation)return {revision:revision(context),operations,automatic,...audit};
    const catalog = await options.catalog(), flows = catalog.entries.filter(entry => entry.target.kind === 'flow' && entry.input?.parameters.some(parameter => parameter.name === 'context' && parameter.type === 'string'));
    return {revision: revision(context),operations,automatic,...audit,targets: automationCatalog({...catalog, entries: flows}).targets};
}
async function authorize(options: ReviewOperationsOptions, context: Context): Promise<void> {
    const actor = await options.service.currentPrincipal();
    requireValue(actor.kind === 'human' && context.board.members?.some(member => member.kind === actor.kind && member.id === actor.id
        && member.roles?.includes('coordinator')), 'OPERATION_COORDINATOR_REQUIRED');
}
async function bind(options: ReviewOperationsOptions, board: string, request: KanbanItemOperationBinding) {
    const context = await load(options, board, request.itemId, false); await authorize(options, context);requireValue(!context.archived,'ITEM_ARCHIVED');
    requireValue(!context.board.lifecycle || request.action === 'accept','BOARD_STOPPING');
    requireValue(context.item.deletedAt === undefined && context.item.status !== 'cancelled' && context.item.control?.action !== 'cancel', 'TASK_CANCELLING');
    requireValue(['build', 'deploy', 'merge'].includes(request.action), 'OPERATION_BINDING_FORBIDDEN');
    requireValue(!context.jobs.some(job => job.phase !== 'settled'), 'OPERATION_IN_USE');
    const catalog = await options.catalog(), target = automationTarget(request.target, catalog); requireValue(target.kind === 'flow', 'OPERATION_FLOW_REQUIRED');
    requireValue(catalog.entries.find(entry => entry.target.digest === target.digest && entry.target.id === target.id)?.input?.parameters.some(parameter => parameter.name === 'context' && parameter.type === 'string'), 'OPERATION_FLOW_CONTEXT_REQUIRED');
    const digest = sha256HexSync(JSON.stringify(request));
    await options.journal.update<ReviewSettings>(reviewKey(board, request.itemId,options.scopeId), old => {
        const saved = old ?? initial(); if (Object.hasOwn(saved.receipts, request.operationId)) {requireValue(saved.receipts[request.operationId] === digest, 'IDEMPOTENCY_CONFLICT'); return saved;}
        requireValue(request.expectedRevision === revision(context) && saved.revision === context.settings.revision, 'OPERATION_STALE_REFRESH');
        requireValue(Object.keys(saved.receipts).length < 256, 'OPERATION_HISTORY_LIMIT');
        return {...saved, revision: saved.revision + 1, bindings: {...saved.bindings, [request.action]: request.target}, receipts: {...saved.receipts, [request.operationId]: digest}};
    });
    return view(options, await load(options, board, request.itemId, false));
}
async function run(options: ReviewOperationsOptions, board: string, request: KanbanItemOperationRequest, origin:OperationOrigin='manual'): Promise<KanbanItemOperations> {
    const automatic=origin!=='manual';
    const context = await load(options, board, request.itemId, false); await authorize(options, context);
    requireValue(!context.archived||request.action==='cancel','ITEM_ARCHIVED');
    if(automatic)requireValue(!context.board.executionControl?.paused,'AUTOMATIC_DELIVERY_PAUSED');
    requireValue(!context.board.lifecycle || request.action === 'accept'||request.action==='cancel','BOARD_STOPPING');
    requireValue(request.action==='cancel'||context.item.deletedAt === undefined && context.item.status !== 'cancelled' && context.item.control?.action !== 'cancel', 'TASK_CANCELLING');
    requireValue(/^[\w-]{1,128}$/.test(request.operationId) && (actions.includes(request.action as ReviewAction)||request.action==='skip'||request.action==='cancel'||request.action==='cleanup'), 'OPERATION_REQUEST_INVALID');
    if(request.action==='cleanup'){
        requireValue(request.expectedRevision===revision(context),'OPERATION_STALE_REFRESH');
        const merged=latest(context,'merge');requireValue(merged?.state==='succeeded'&&context.cleanup?.runId===merged.id&&!context.jobs.some(job=>job.phase!=='settled'),'OPERATION_PREREQUISITE_REQUIRED');
        await finishReviewCleanup(options,board,request.itemId,merged.id,true);return view(options,await load(options,board,request.itemId,false));
    }
    if(request.cancel){
        const job=context.jobs.find(row=>row.id===request.cancel!.runId);requireValue(job,'OPERATION_SCOPE_MISMATCH');
        const saved=await options.journal.get<ReviewCancellation>(cancellationKey(job.id));requireValue(saved?.id===request.operationId||request.expectedRevision===revision(context),'OPERATION_STALE_REFRESH');
        requireValue(saved?.id===request.operationId||job.phase!=='settled','OPERATION_ALREADY_SETTLED');await requestCancellation(options,board,request,job);return view(options,await load(options,board,request.itemId,false));
    }
    if(request.skip){
        const key='review-skip:'+request.operationId,prior=await options.journal.get(key);
        requireValue(prior||request.expectedRevision===revision(context),'OPERATION_STALE_REFRESH');
        const current=await view(options,context);await skipItemOperations(options,context,request,current.operations);
        await settleDeliveryAcceptance(options,board,request.itemId);
        return view(options,await load(options,board,request.itemId,false));
    }
    requireValue(!context.cancellations.some(pendingCancellation),'OPERATION_CANCELLING');
    const prior = await options.journal.get<ReviewJob>(jobKey(request.operationId));
    requireValue(!prior || prior.boardId === board && prior.itemId === request.itemId && prior.fingerprint === sha256HexSync(JSON.stringify(request)), 'IDEMPOTENCY_CONFLICT');
    if (prior && context.settings.jobs.includes(prior.id)) {requireValue(prior.fingerprint === sha256HexSync(JSON.stringify(request)), 'IDEMPOTENCY_CONFLICT'); return view(options, context);}
    requireValue(request.expectedRevision === revision(context), 'OPERATION_STALE_REFRESH');
    const waivers=await currentWaivers(options,context);
    const entry = operation(context, request.action as ReviewAction, context.jobs.some(job => job.phase !== 'settled'), options.adapter.supports?.(context.board, context.item) !== false && (options.adapter.ready?.(context.board,context.item)??['review', 'completed'].includes(context.item.status)), !!options.adapter.prepareOperation,waivers);
    requireValue(!waivers.some(row=>row.operations.some(op=>op.id===request.action)),'OPERATION_SKIPPED');
    requireValue(entry.enabled, 'OPERATION_PREREQUISITE_REQUIRED');
    await requireOperationAuthority({...options,...developmentAuthority},context,request,origin);
    requireValue(request.followUp===undefined||request.action==='build'&&request.followUp==='deploy'&&!context.deliveryPlan?.manualAfter,'OPERATION_REQUEST_INVALID');
    const input = await operationInput(options, context, request), job = prior ?? (request.action === 'accept' ? await acceptanceJob(options, context, request)
        : await prepareReviewJob(options, context.board, context.item, context.settings, request, input,request.action==='analyze'?latest(context,'accept')?.snapshot.sourceVersion:undefined));
    await options.journal.update<Array<{board: string; item: string;scopeId?:string}>>('review-operation-scopes', old => old?.some(row => row.board === board && row.item === request.itemId&&row.scopeId===options.scopeId) ? old : [...old ?? [], {board, item: request.itemId,...(options.scopeId?{scopeId:options.scopeId}:{})}]);
    await options.journal.update<ReviewJob>(jobKey(job.id), old => {requireValue(!old || old.fingerprint === job.fingerprint, 'IDEMPOTENCY_CONFLICT'); return old ?? job;});
    await options.journal.update<ReviewSettings>(reviewKey(board, request.itemId,options.scopeId), old => {
        const saved = old ?? initial(); requireValue(saved.revision === context.settings.revision, 'OPERATION_STALE_REFRESH'); requireValue(saved.jobs.length < 64, 'OPERATION_HISTORY_LIMIT');
        return {...saved, revision: saved.revision + 1,invalidatedAnalysis:request.action==='analyze'?undefined:saved.invalidatedAnalysis,jobs: [...saved.jobs, job.id]};
    });
    await options.report?.(job); if(!automatic||!(await options.service.read(board)).executionControl?.paused)await advanceReviewJob(options,job);if(request.action==='build')await followUp(options,board,request.itemId);await settleDeliveryAcceptance(options,board,request.itemId);return view(options,await load(options,board,request.itemId,false));
}
async function operationInput(options: ReviewOperationsOptions, context: Context, request: KanbanItemOperationRequest): Promise<unknown> {
    if (request.action === 'deploy') {
        const built = latest(context, 'build')!, snapshot = await options.adapter.snapshot(context.board, context.item);
        requireValue(snapshot.version === built.snapshot.version, 'OPERATION_SOURCE_CHANGED_REBUILD'); return built.result;
    }
    if (request.action !== 'merge') return;
    const analysis = latest(context, 'analyze')!, plan = analysis.result as MergePlan, selections = request.selections ?? {};
    requireValue(Object.keys(selections).length === plan.conflicts.length && plan.conflicts.every(conflict => Object.hasOwn(selections, conflict.id) && conflict.options.some(option => option.id === selections[conflict.id])), 'OPERATION_SELECTION_REQUIRED');
    const current = await options.adapter.snapshot(context.board, context.item);
    if(current.version!==analysis.snapshot.version){
        const code=current.sourceVersion!==analysis.snapshot.sourceVersion?'OPERATION_SOURCE_CHANGED_REANALYZE':'OPERATION_TARGET_CHANGED_REANALYZE';
        await invalidateReviewAnalysis({...options,policy:developmentAnalysisPolicy},context.board.id,context.item.id,analysis.id,code,request.operationId);requireValue(false,code);
    }
    return {approvalId: request.operationId, analysisId: analysis.id, analysisDigest: sha256HexSync(JSON.stringify(plan)),
        sourceVersion: current.sourceVersion, targetVersion: current.targetVersion, selections, plan};
}
async function acceptanceJob(options: ReviewOperationsOptions, context: Context, request: KanbanItemOperationRequest): Promise<ReviewJob> {
    const deployed = latest(context, 'deploy'), snapshot = await options.adapter.snapshot(context.board, context.item),scope=context.deliveryPlan?.acceptance??'runtime';
    let version:string|undefined,acceptanceEvidence:unknown;
    if(scope==='runtime'){
        requireValue(deployed&&snapshot.sourceVersion===deployed.snapshot.sourceVersion,'OPERATION_SOURCE_CHANGED_REBUILD');
        const merged=latest(context,'merge'),targetHead=(merged?.result as {targetHead?:string})?.targetHead;
        const integrated=merged?.state==='succeeded'&&merged.snapshot.sourceVersion===deployed.snapshot.sourceVersion&&targetHead&&snapshot.targetVersion===targetHead;
        requireValue(snapshot.version===deployed.snapshot.version||integrated,'OPERATION_SOURCE_CHANGED_REBUILD');
        version=(deployed.result as {version:string}).version;
        if(options.adapter.runningVersion?.()!==version){
            const replacement=await options.adapter.acceptanceVersion?.(context.board,context.item,version!);
            requireValue(replacement&&replacement.version===options.adapter.runningVersion?.(),'OPERATION_RUNNING_VERSION_MISMATCH');
            version=replacement.version;acceptanceEvidence=replacement.receipt;
        }
    }
    const commands=await options.adapter.acceptanceCommands?.(context.board,context.item);
    const workflow = await options.service.workflow(context.board.id), dispatch = Object.values(workflow.dispatches).filter(row => row.itemId === context.item.id).sort((a, b) => b.attempt - a.attempt)[0];
    requireValue(commands!==undefined||dispatch?.outcome === 'succeeded', 'OPERATION_ACCEPTANCE_UNAVAILABLE');
    return {id: request.operationId, boardId: context.board.id, itemId: context.item.id, scopeId:options.scopeId, action: 'accept', phase: 'prepared', state: 'running',
        fingerprint: sha256HexSync(JSON.stringify(request)), snapshot, createdAt: Date.now(), acceptanceVersion: version,acceptanceScope:scope,...(acceptanceEvidence===undefined?{}:{acceptanceEvidence}),
        ...(commands!==undefined?{commands}:{command: {type: 'accept-execution' as const, dispatchId: dispatch!.id, accept: true}})};
}

function validateRequest(request: KanbanItemOperationRequest | KanbanItemOperationBinding): void {
    requireValue(request?.scopeId===undefined||typeof request.scopeId==='string'&&/^[\w-]{1,128}$/.test(request.scopeId),'OPERATION_SCOPE_INVALID');
    requireValue(request && typeof request === 'object' && typeof request.itemId === 'string' && request.itemId.length > 0 && request.itemId.length <= 256
        && typeof request.operationId === 'string' && /^[\w-]{1,128}$/.test(request.operationId) && !['__proto__', 'constructor', 'prototype'].includes(request.operationId)
        && (actions.includes(request.action as ReviewAction)||request.action==='skip'||request.action==='cancel'||request.action==='cleanup') && typeof request.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(request.expectedRevision), 'OPERATION_REQUEST_INVALID');
    if(request.action==='cancel')requireValue('cancel'in request&&!!request.cancel&&typeof request.cancel.runId==='string'&&!('target'in request)&&request.followUp===undefined,'OPERATION_REQUEST_INVALID');
    else if('cancel'in request)requireValue(request.cancel===undefined,'OPERATION_REQUEST_INVALID');
    if(request.action==='skip'){requireValue('skip'in request&&!!request.skip&&typeof request.skip==='object'&&!Array.isArray(request.skip)&&actions.includes(request.skip.action as ReviewAction)&&request.followUp===undefined,'OPERATION_REQUEST_INVALID');}
    else if('skip'in request)requireValue(request.skip===undefined,'OPERATION_REQUEST_INVALID');
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
    if(context.cancellations.some(row=>row.runId===build?.id&&!['failed','not-required'].includes(row.state)))return;
    if((await currentWaivers(options,context)).some(row=>row.operations.some(op=>op.id==='deploy')))return;
    if(context.board.executionControl?.paused||context.board.lifecycle||context.item.deletedAt||context.item.control?.action==='cancel')return;
    if(build?.state!=='succeeded'||build.phase!=='settled'||build.followUp?.state!=='queued')return;
    const id='deploy-'+sha256HexSync(build.id).slice(0,48),deployed=latest(context,'deploy');
    if(deployed&&deployed.createdAt>=build.createdAt){await markFollowUp(options,build,'started');return;}
    if(context.jobs.some(job=>job.phase!=='settled'))return;
    const request=build.followUp.request??{operationId:id,itemId:item,scopeId:options.scopeId,action:'deploy',expectedRevision:revision(context)};
    await options.journal.update<ReviewJob>(jobKey(build.id),old=>({...old!,followUp:{...old!.followUp!,request:old!.followUp!.request??request}}));
    try{await run(options,board,request,{followUp:build.id});await markFollowUp(options,build,'started');}
    catch(error){
        if(await options.journal.get<ReviewJob>(jobKey(id)))return;
        const code=safeCode(error,'OPERATION_AUTO_DEPLOY_FAILED');if(code==='AUTOMATIC_DELIVERY_PAUSED')return;await markFollowUp(options,build,'failed',code);
        options.log({operationId:id,stage:'operation.auto-deploy.prepare',result:'failure',code,durationMs:Date.now()-started});
    }
}
async function markFollowUp(options:ReviewOperationsOptions,build:ReviewJob,state:'started'|'failed',code?:string) {
    await options.journal.update<ReviewJob>(jobKey(build.id),old=>({...old!,followUp:{...old!.followUp!,state,code}}));
}

/** Only an unadmitted acceptance may retry after trusted runtime provenance becomes available. */
async function recoverAcceptancePrecondition(options:ReviewOperationsOptions,board:string,item:string,action:string,code:string):Promise<boolean> {
    if(action!=='accept'||code!=='OPERATION_RUNNING_VERSION_MISMATCH'||!options.adapter.acceptanceVersion)return false;
    const context=await load(options,board,item,false),deployed=latest(context,'deploy');
    const expected=(deployed?.result as {version?:string})?.version;if(!expected)return false;
    const proof=await options.adapter.acceptanceVersion(context.board,context.item,expected);
    return !!proof&&proof.version===options.adapter.runningVersion?.();
}

async function currentWaivers(options:ReviewOperationsOptions,context:Context) {
    if(options.scopeId||!context.item.operationWaivers?.length)return [];
    const workflow=await options.service.workflow(context.board.id),dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===context.item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    return effectiveOperationWaivers(context.item.operationWaivers.filter(row=>row.dispatchId===dispatch?.id),context.deliveryPlan);
}

async function cleanupAfterSubmission(options:ReviewOperationsOptions,board:string,item:string,id:string):Promise<boolean> {
    const context=await load(options,board,item,false),merged=latest(context,'merge');
    return merged?.state==='succeeded'?finishReviewCleanup(options,board,item,merged.id):options.cleanup?.(board,item,id)??false;
}

async function settleDeliveryAcceptance(options:ReviewOperationsOptions,board:string,item:string):Promise<void> {
    const context=await load(options,board,item,false),current=await view(options,context);
    const required=current.operations.filter(row=>row.runAction!=='cleanup');
    if(!required.every(row=>['succeeded','skipped'].includes(row.state)))return;
    const waivers=await currentWaivers(options,context),waiver=waivers.find(row=>row.acceptanceWaived),accepted=latest(context,'accept');
    if(options.scopeId&&accepted?.state==='succeeded'&&accepted.commands){
        for(const [index,command] of accepted.commands.entries())await journalCommand(options.journal,options.service,board,'review-accept:'+accepted.id+':'+index,command);
    }else if(context.item.status==='review'){
        if(waiver)await journalCommand(options.journal,options.service,board,'review-waived-accept:'+waiver.id,{type:'accept-execution',dispatchId:waiver.dispatchId,accept:true,waiverId:waiver.id});
        else if(accepted?.state==='succeeded'&&accepted.command)await journalCommand(options.journal,options.service,board,'review-accept:'+accepted.id,accepted.command);
        else return;
    }
    const merged=latest(context,'merge');
    if(merged?.state==='succeeded'&&!waivers.some(row=>row.operations.some(op=>op.id==='cleanup')))await finishReviewCleanup(options,board,item,merged.id);
}

function cancellationView(options:ReviewOperationsOptions,context:Context,entry:KanbanItemOperation):KanbanItemOperation {
    const job=latest(context,entry.id as ReviewAction);if(!job)return entry;
    const enabled=entry.enabled,cancel=context.cancellations.find(row=>row.runId===job.id),pending=pendingCancellation(cancel),cancelled=cancel?.state==='cancelled';
    if(pending||cancelled){entry={...entry,state:cancelled?'cancelled':'cancelling',enabled:false,followUp:undefined,reason:undefined,code:cancel?.code??(cancelled&&job.code!=='OPERATION_CANCELLED'?job.code:undefined),progress:pending?{stage:'cancelling',label:t('kanban.operationProgress.cancelling'),requestedAt:cancel!.requestedAt}:undefined};}
    if(job.phase!=='settled'||cancel)entry.cancel={affected:affectedOperations(operationDependencies(context.deliveryPlan),job.action).map(id=>({id,label:t(('kanban.operationAction.'+id) as Parameters<typeof t>[0]),group:operationGroup(id)})),runId:job.id,enabled:!pending&&!cancelled&&job.phase!=='settled'&&cancellationSupported(options,job),...(cancel?{operationId:cancel.id,state:cancel.state,code:cancel.code,requestedAt:cancel.requestedAt}:{}),...(!cancellationSupported(options,job)?{reason:t(job.managed?'kanban.operationCancelUnsupported':'kanban.operationCancelUnavailable')}:{})};
    if(cancelled)entry.enabled=enabled;
    return entry;
}

function cancelDependentOperations(context:Context,entries:KanbanItemOperation[]):KanbanItemOperation[] {
    const graph=operationDependencies(context.deliveryPlan);
    return entries.map(entry=>{
        if(entry.state==='succeeded')return entry;
        const cancellation=[...context.cancellations].reverse().find(cancel=>{
            const job=context.jobs.find(row=>row.id===cancel.runId);
            return job&&latest(context,job.action)?.id===job.id&&!['failed','not-required'].includes(cancel.state)
                &&job.action!==entry.id&&affectedOperations(graph,job.action).includes(entry.id);
        });
        if(!cancellation)return entry;
        const live=latest(context,entry.id as ReviewAction);
        if(live?.phase&&live.phase!=='settled')return {...entry,enabled:false,reason:t('kanban.operationDependencyCancelling')};
        return {...entry,state:cancellation.state==='cancelled'?'cancelled':'cancelling',enabled:false,hideRun:true,
            progress:undefined,followUp:undefined,reason:t('kanban.operationDependencyCancelled')};
    });
}

function operationHalt(context:Context,waivers:NonNullable<KanbanItem['operationWaivers']>):import('@nestos/kanban/contracts').KanbanItemOperations['halted'] {
    for(const cancel of [...context.cancellations].reverse()){
        const job=context.jobs.find(row=>row.id===cancel.runId);
        if(!job||['failed','not-required'].includes(cancel.state))continue;
        if(latest(context,job.action)?.id!==job.id||waivers.some(row=>row.operations.some(op=>op.id===job.action)))continue;
        return {runId:job.id,state:cancel.state==='cancelled'?'cancelled':'cancelling'};
    }
}

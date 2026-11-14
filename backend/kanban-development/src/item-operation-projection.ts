import {t} from '@nestos/common';
import type {KanbanItem,KanbanItemOperation} from '@nestos/kanban/contracts';
import type {ReviewContext as Context,ReviewAction,ReviewJob,MergePlan} from './item-operation-types';
import {operationDependencies} from './item-operation-skips';
import {operationSteps} from './development-operation-policy';
export function latestReviewJob(context:Context,action:ReviewAction):ReviewJob|undefined {
    const job=context.jobs.filter(row=>row.action===action).at(-1);if(!job||job.phase!=='settled')return job;
    const steps=operationSteps(context.deliveryPlan?.steps,context.deliveryPlan?.ordering),ancestors=steps.slice(0,steps.indexOf(action));
    const position=context.jobs.indexOf(job);
    return context.jobs.some((row,index)=>index>position&&ancestors.includes(row.action))?undefined:job;
}
const latest=latestReviewJob;
function prerequisitesSatisfied(context:Context,action:string,waivers:NonNullable<KanbanItem['operationWaivers']>):boolean {
    const graph=operationDependencies(context.deliveryPlan),settled=new Set(Object.keys(graph).filter(id=>
        latest(context,id as ReviewAction)?.state==='succeeded'&&(id!=='analyze'||context.settings.invalidatedAnalysis?.id!==latest(context,'analyze')?.id)||id==='accept'&&!context.scoped&&context.item.status==='completed'));
    const skipped=new Set(waivers.flatMap(row=>row.operations.map(op=>op.id)));
    for(const [id,deps] of Object.entries(graph))if(skipped.has(id)&&deps.every(dep=>settled.has(dep)))settled.add(id);
    return (graph[action]??[]).every(dep=>settled.has(dep));
}
export function operation(context: Context, action: ReviewAction, active: boolean, supported: boolean, agent = false,waivers:NonNullable<KanbanItem['operationWaivers']>=[]): KanbanItemOperation {
    const job=latest(context,action),binding=context.settings.bindings[action],analysis=latest(context,'analyze');
    const invalidated=!!analysis&&context.settings.invalidatedAnalysis?.id===analysis.id,plan=invalidated?undefined:analysis?.result as MergePlan|undefined;
    const ready=prerequisitesSatisfied(context,action,waivers)&&(action!=='deploy'||latest(context,'build')?.state==='succeeded')
        &&(action!=='merge'||!!plan&&latest(context,'analyze')?.state==='succeeded')&&(action!=='accept'||context.item.status==='review'||!!context.deliveryPlan&&context.item.planning?.execution==='children');
    const configurable = !agent && ['build', 'deploy', 'merge'].includes(action), finished = action === 'accept' && (!context.scoped&&context.item.status === 'completed'||job?.state==='succeeded') || action === 'merge' && job?.state === 'succeeded';
    const enabled = (!context.deliveryPlan||context.deliveryPlan.steps.includes(action)) && supported && !context.archived && !finished && !active && ready && (!configurable || !!binding);
    const built=latest(context,'build'),auto=built?.followUp,autoPending=action==='deploy'&&auto?.state==='queued'&&built?.state==='succeeded'&&(!job||job.createdAt<built.createdAt);
    return {...(action==='build'?{runLabel:job?.state==='succeeded'?t('kanban.operationRebuild'):undefined,...(!context.deliveryPlan?.manualAfter?{followUp:{action:'deploy',label:t('kanban.operationAutoDeploy'),confirmation:t('kanban.operationConfirmDeploy')}}:{})}:{}),...(action==='deploy'?{hideRun:!!auto&&auto.state!=='failed'&&!(job&&job.createdAt>=(built?.createdAt??0)&&job.state==='failed')}:{}),id: action, label: action==='accept'&&context.deliveryPlan?.acceptanceLabel||t(('kanban.operationAction.' + action) as Parameters<typeof t>[0]),
        state:action==='merge'&&invalidated&&(!job||job.phase==='settled')?'unavailable':action==='analyze'&&invalidated?(enabled?'ready':'unavailable'):autoPending?'running':action==='deploy'&&auto?.state==='failed'?'failed':action === 'accept' && !context.scoped&&context.item.status === 'completed' ? 'succeeded' : job?.phase !== undefined && job.phase !== 'settled' ? job.state : job?.state ?? (enabled ? action === 'accept' || action === 'merge' ? 'waiting-confirmation' : 'ready' : 'unavailable'), enabled,
        ...(job?.state==='unknown'?{attention:{kind:'recovery' as const}}:action==='merge'&&plan?.conflicts.length?{attention:{kind:'choice' as const}}:{}),
        ...(job?.state==='unknown'&&job.phase==='submitting'?{recovery:{runId:job.id,label:t('kanban.operationReconcile'),
            reason:t(['GIT_IDENTITY_MISSING','GIT_COMMIT_IDENTITY_REQUIRED'].includes(job.code??'')?'kanban.operationRecoveryIdentity':job.code==='OPERATION_RESULT_PENDING'?'kanban.operationRecoveryMissingResult':'kanban.operationRecoveryUnavailable'),
            prompt:t('kanban.operationRecoveryPrompt',{operationId:job.id,source:job.snapshot.sourceVersion,target:job.snapshot.targetVersion})}}:{}),
        statusText:operationStatusText(context,action),progress:operationProgress(job,autoPending),
        code:action==='deploy'&&auto?.state==='failed'?auto.code:job?.code==='WORKSPACE_CONTEXT_PENDING'?undefined:job?.code, runId: job?.id, sessionId: job?.sessionId??(action==='merge'?latest(context,'analyze')?.sessionId:undefined), configurable, binding, openSessionOnRun: agent || action === 'analyze',
        reason: job?.phase&&job.phase!=='settled'||autoPending ? undefined : enabled || finished ? undefined : t(!supported ? 'kanban.operationNeedsDelivery' : active ? 'kanban.operationBusy' : configurable && !binding ? 'kanban.operationNeedsFlow' : 'kanban.operationNeedsPrevious'),
        summary:action==='analyze'||action==='merge'?plan?plan.summary+'\n'+t('kanban.operationVersions',{source:plan.sourceVersion,target:plan.targetVersion}):undefined:resultSummary(job?.result),
        fields: action === 'merge' && plan ? plan.conflicts.map(conflict => ({id: conflict.id, label: conflict.path + ' · ' + conflict.reason, choices: conflict.options})) : undefined,
        confirmation: action === 'deploy' ? t('kanban.operationConfirmDeploy') : action === 'accept' ? context.deliveryPlan?.acceptanceConfirmation===null?undefined:context.deliveryPlan?.acceptanceConfirmation??t('kanban.operationConfirmAcceptance') : action === 'merge' ? t(plan?.conflicts.length?'kanban.operationConfirmMerge':'kanban.operationConfirmMergeNoConflicts') : undefined};
}
function operationStatusText(context:Context,action:ReviewAction):string|undefined {
    const job=latest(context,action),analysis=latest(context,'analyze'),plan=analysis?.result as MergePlan|undefined;
    if(action==='analyze'&&!job)return t('kanban.operationAnalysisOnly');
    if(action!=='merge')return;
    if(analysis&&context.settings.invalidatedAnalysis?.id===analysis.id)return t('kanban.operationMergePlanExpired');
    if(job?.state==='succeeded')return t('kanban.operationMergeVerified');
    if(job&&job.phase!=='settled')return t(job.state==='unknown'?'kanban.operationMergeUnverified':'kanban.operationMergeExecuting');
    if(analysis?.state==='succeeded'&&plan)return plan.conflicts.length?t('kanban.operationMergeConflicts',{count:plan.conflicts.length}):t('kanban.operationMergeNoConflicts');
}

function resultSummary(result: unknown): string | undefined {
    const value = result as {summary?: string; version?: string} | undefined;
    return [typeof value?.summary === 'string' ? value.summary.slice(0, 8000) : undefined, typeof value?.version === 'string' ? t('kanban.operationVersion', {version: value.version}) : undefined].filter(Boolean).join('\n') || undefined;
}
function operationProgress(job:ReviewJob|undefined,queued:boolean):KanbanItemOperation['progress'] {
    const stage=queued?'queued':!job||job.phase==='settled'?undefined:job.code==='WORKSPACE_CONTEXT_PENDING'?'waiting-context':job.state==='unknown'?'reconciling':job.phase==='prepared'?'preparing':'running';
    if(!stage)return;
    return {stage,label:t(('kanban.operationProgress.'+stage) as Parameters<typeof t>[0]),...(!queued&&job?.createdAt?{requestedAt:job.createdAt}:{})};
}

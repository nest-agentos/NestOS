import {selectDeliverySteps,jobKey,reviewKey,reviewCleanupKey,type AutomaticDeliveryPolicy} from '@nestos/kanban/integration';
export const developmentDeliveryPolicy:AutomaticDeliveryPolicy={steps:['build','deploy','accept','analyze','merge','cleanup'],targetActions:['build','deploy','accept','analyze','merge'],finalizeAction:'cleanup',handoffAction:'accept',refreshAction:'analyze',refreshableActions:['analyze','merge'],refreshCodes:['OPERATION_SOURCE_CHANGED_REANALYZE','OPERATION_TARGET_CHANGED_REANALYZE','MERGE_PLAN_SOURCE_CHANGED'],unstartedCodes:['OPERATION_ORIGINAL_SESSION_BUSY','OPERATION_WORKSPACE_BUSY','OPERATION_STALE_REFRESH']};
export const operationSteps=(configured=developmentDeliveryPolicy.steps,ordering?:'configured')=>selectDeliverySteps(configured,developmentDeliveryPolicy.steps,ordering);

export const developmentAnalysisPolicy={analysisAction:'analyze',integrationAction:'merge',refreshCodes:developmentDeliveryPolicy.refreshCodes,sourceChangedCode:'OPERATION_SOURCE_CHANGED_REANALYZE',targetChangedCode:'OPERATION_TARGET_CHANGED_REANALYZE',staleCode:'MERGE_PLAN_SOURCE_CHANGED',initialPrerequisites:['accept']};
export const developmentAuthority={confirmationActions:['deploy','merge'],followUpActions:{build:'deploy'},acceptanceAction:'accept',canonicalSteps:developmentDeliveryPolicy.steps};

/** Release only scopes whose settled evidence proves that the target is idle. */
export async function releasableDevelopmentTarget(options:Pick<import('./item-operation-types').ReviewOperationsOptions,'service'|'adapter'|'journal'>,scope:import('@nestos/kanban/integration').DeliveryScope,state:import('@nestos/kanban/integration').AutomaticDeliveryState):Promise<boolean> {
    const finalizer=!state.targetActions&&!scope.scopeId&&state.cleanupPrecondition&&state.steps?.length===1&&state.steps[0]===developmentDeliveryPolicy.finalizeAction;
    const action=state.steps?.[state.step],request=action?state.requests[action]:undefined;
    const promptFailure=state.code==='PROMPT_BUNDLE_INVALID'||state.code==='PROMPT_BUNDLE_COUNT_LIMIT';
    const preparation=action===developmentDeliveryPolicy.refreshAction&&(state.code==='WORKTREE_MISSING'||promptFailure)
        &&request&&!await options.journal.get(jobKey(request.operationId));
    const finalization=!!scope.scopeId&&(action==='accept'||action===developmentDeliveryPolicy.finalizeAction)
        &&await acceptedScopeCleanup(options.journal,scope);
    const unpublished=!!scope.scopeId&&state.scopeId===scope.scopeId&&await awaitingNewApproval(options.journal,scope,action,state.code,request?.operationId);
    if(!finalizer&&!preparation&&!finalization&&!unpublished)return false;
    const board=await options.service.read(scope.boardId),{item}=await options.service.item(scope.boardId,scope.itemId);
    const projects=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
    return (!(finalizer||finalization)||item.status==='completed')&&!item.deletedAt&&item.status!=='cancelled'&&item.planning?.execution==='children'&&state.executionId===item.id
        &&projects.length===1&&projects[0].id===scope.target
        &&((promptFailure||finalization||unpublished)&&!!scope.scopeId&&state.scopeId===scope.scopeId||options.adapter.supports?.(board,item)===true);
}

async function awaitingNewApproval(journal:import('@nestos/kanban/integration').KanbanAutomationJournal,scope:import('@nestos/kanban/integration').DeliveryScope,action:string|undefined,code:string|undefined,id:string|undefined):Promise<boolean> {
    if(action==='merge'&&code==='OPERATION_SELECTION_REQUIRED')return unpublishedScope(journal,scope);
    if(action!=='analyze'||!id||!['OPERATION_RESULT_PENDING','MERGE_PLAN_SOURCE_CHANGED'].includes(code??''))return false;
    const job=await journal.get<import('./item-operation-types').ReviewJob>(jobKey(id));
    return job?.phase==='settled'&&job.state==='failed'&&job.action==='analyze'&&job.code==='MERGE_PLAN_SOURCE_CHANGED'
        &&job.boardId===scope.boardId&&job.itemId===scope.itemId&&job.scopeId===scope.scopeId&&await unpublishedScope(journal,scope);
}

async function unpublishedScope(journal:import('@nestos/kanban/integration').KanbanAutomationJournal,scope:import('@nestos/kanban/integration').DeliveryScope):Promise<boolean> {
    const {boardId,itemId,scopeId}=scope;
    const settings=await journal.get<import('./item-operation-types').ReviewSettings>(reviewKey(boardId,itemId,scopeId));
    if(!settings?.jobs.length)return false;
    const jobs=await journal.getMany<import('./item-operation-types').ReviewJob>(settings.jobs.map(jobKey));
    const unstarted=['MERGE_PLAN_CONFLICTS_MISSING','OPERATION_RESULT_INTEGRATION_UNSUPPORTED','CONTEXT_NATIVE_BUSY'];
    return jobs.every(job=>job?.phase==='settled'&&job.boardId===boardId&&job.itemId===itemId&&job.scopeId===scopeId
        &&(job.action==='analyze'||job.action==='merge'&&job.state==='failed'&&unstarted.includes(job.code??'')));
}

async function acceptedScopeCleanup(journal:import('@nestos/kanban/integration').KanbanAutomationJournal,scope:import('@nestos/kanban/integration').DeliveryScope):Promise<boolean> {
    const {boardId,itemId,scopeId}=scope;
    const cleanup=await journal.get<import('@nestos/kanban/integration').ReviewCleanup>(reviewCleanupKey(boardId,itemId,scopeId));
    if(!cleanup)return false;
    const settings=await journal.get<import('./item-operation-types').ReviewSettings>(reviewKey(boardId,itemId,scopeId));
    const jobs=await journal.getMany<import('./item-operation-types').ReviewJob>((settings?.jobs??[]).map(jobKey));
    const settled=(job:import('./item-operation-types').ReviewJob|undefined,action:string)=>job?.phase==='settled'
        &&job.state==='succeeded'&&job.action===action&&job.boardId===boardId&&job.itemId===itemId&&job.scopeId===scopeId;
    return jobs.some(job=>settled(job,'accept'))&&jobs.some(job=>job?.id===cleanup.runId&&settled(job,'merge'));
}

/** Historical waivers settle delivery only for the accepted dispatch, never a new handoff. */
export function fullyWaivedDevelopmentDelivery(item:import('@nestos/kanban/contracts').KanbanItem,dispatch:import('@nestos/kanban/contracts').KanbanDispatch|undefined):boolean {
    const acceptance=item.acceptanceResult;
    if(item.status!=='completed'||dispatch?.itemId!==item.id||dispatch.outcome!=='accepted'||acceptance?.outcome!=='waived'||acceptance.dispatchId!==dispatch.id)return false;
    const waivers=(item.operationWaivers??[]).filter(row=>row.dispatchId===dispatch.id);
    if(!waivers.some(row=>row.id===acceptance.waiverId&&row.acceptanceWaived&&row.operations.some(op=>op.id==='accept')))return false;
    const waived=new Set(waivers.flatMap(row=>row.operations.map(op=>op.id)));
    return developmentDeliveryPolicy.steps.filter(action=>action!==developmentDeliveryPolicy.refreshAction).every(action=>waived.has(action));
}

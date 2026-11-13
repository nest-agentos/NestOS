import {selectDeliverySteps,jobKey,type AutomaticDeliveryPolicy} from '@nestos/kanban/integration';
export const developmentDeliveryPolicy:AutomaticDeliveryPolicy={steps:['build','deploy','accept','analyze','merge','cleanup'],targetActions:['build','deploy','accept','analyze','merge'],finalizeAction:'cleanup',handoffAction:'accept',refreshAction:'analyze',refreshableActions:['analyze','merge'],refreshCodes:['OPERATION_SOURCE_CHANGED_REANALYZE','OPERATION_TARGET_CHANGED_REANALYZE','MERGE_PLAN_SOURCE_CHANGED'],unstartedCodes:['OPERATION_ORIGINAL_SESSION_BUSY','OPERATION_WORKSPACE_BUSY','OPERATION_STALE_REFRESH']};
export const operationSteps=(configured=developmentDeliveryPolicy.steps,ordering?:'configured')=>selectDeliverySteps(configured,developmentDeliveryPolicy.steps,ordering);

export const developmentAnalysisPolicy={analysisAction:'analyze',integrationAction:'merge',refreshCodes:developmentDeliveryPolicy.refreshCodes,sourceChangedCode:'OPERATION_SOURCE_CHANGED_REANALYZE',targetChangedCode:'OPERATION_TARGET_CHANGED_REANALYZE',staleCode:'MERGE_PLAN_SOURCE_CHANGED',initialPrerequisites:['accept']};
export const developmentAuthority={confirmationActions:['deploy','merge'],followUpActions:{build:'deploy'},acceptanceAction:'accept',canonicalSteps:developmentDeliveryPolicy.steps};

/** Release independent cleanup and positively unsubmitted analysis failures. */
export async function releasableDevelopmentTarget(options:Pick<import('./item-operation-types').ReviewOperationsOptions,'service'|'adapter'|'journal'>,scope:import('@nestos/kanban/integration').DeliveryScope,state:import('@nestos/kanban/integration').AutomaticDeliveryState):Promise<boolean> {
    const finalizer=!state.targetActions&&!scope.scopeId&&state.cleanupPrecondition&&state.steps?.length===1&&state.steps[0]===developmentDeliveryPolicy.finalizeAction;
    const action=state.steps?.[state.step],request=action?state.requests[action]:undefined;
    const preparation=action===developmentDeliveryPolicy.refreshAction&&state.code==='WORKTREE_MISSING'&&request&&!await options.journal.get(jobKey(request.operationId));
    if(!finalizer&&!preparation)return false;
    const board=await options.service.read(scope.boardId),{item}=await options.service.item(scope.boardId,scope.itemId);
    const projects=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
    return (!finalizer||item.status==='completed')&&!item.deletedAt&&item.status!=='cancelled'&&item.planning?.execution==='children'&&state.executionId===item.id
        &&projects.length===1&&projects[0].id===scope.target&&options.adapter.supports?.(board,item)===true;
}

import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {KanbanPlanningSession} from '@nestos/kanban/contracts';
import {currentAnalysis,safeCode} from '@nestos/kanban/integration';
import {requireValue} from './validation';
/** Register observation of a verified retained planning Session; never create or relocate one. */
export function adoptPlanningConversation(options:DecisionConversationOptions,start:(board:string,request:{operationId:string})=>Promise<unknown>) {
 return async(board:string,item:string,session:KanbanPlanningSession):Promise<void>=>{
    const started=Date.now();
    if(await options.journal.get('record-conversation:'+session.analysisId))return;
    const analysis=await currentAnalysis(options.journal,board,item);if(analysis?.id!==session.analysisId||analysis.phase!=='settled')return;
    const workspace=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+session.analysisId);
    const context=workspace?.context as {decision?:{recordId:string;sourceBoardId:string}}|undefined;if(!workspace||!context?.decision||!session.resourceId)return;
    const choice=await options.journal.get<{profileId:string}>('kanban-harness-choice:'+session.analysisId);requireValue(choice,'KANBAN_HARNESS_BINDING_CHANGED');
    const channel=await options.remote.sessionChannel(workspace.projectId,'messages',{scopeId:session.analysisId}) as {execution?:{sessionId?:string}};
    const native=channel.execution?.sessionId;requireValue(native&&session.resourceId.endsWith('/'+encodeURIComponent(choice.profileId)+'/'+encodeURIComponent(native)),'PLANNING_SOURCE_UNVERIFIED');
    const record=await options.service.record(context.decision.sourceBoardId,context.decision.recordId),harness=await options.remote.projectHarness(workspace.projectId);
    let epoch:string;try{epoch=(await harness.profiles()).epoch;}finally{await harness.close();}
    const workspaceId=options.remote.list(workspace.projectId).find(row=>row.at==='/')?.serverProjectId;requireValue(workspaceId,'DECISION_PROJECT_BINDING_CHANGED');
    const binding={id:session.analysisId,boardId:context.decision.sourceBoardId,purpose:'coordination' as const,recordId:record.id,projectId:workspace.projectId,
        projectIds:record.externalRefs?.filter(ref=>ref.system==='nestos-remote-project').map(ref=>ref.id),profileId:choice.profileId,workspaceId,directory:workspace.directory,epoch,createId:session.analysisId,inputId:session.analysisId};
    await options.journal.update<DecisionConversation>('record-conversation:'+session.analysisId,old=>old??{id:session.analysisId,boardId:binding.boardId,purpose:'coordination',recordId:record.id,state:'confirmed',phase:'submitting',submitted:true,createdAt:record.createdAt,sessionId:native,resourceId:session.resourceId,binding});
    options.log({operationId:session.analysisId,boardId:binding.boardId,stage:'coordination.session.adopt',result:'success',durationMs:Date.now()-started});
    void start(binding.boardId,{operationId:session.analysisId}).catch(error=>options.log({operationId:session.analysisId,boardId:binding.boardId,stage:'coordination.session.watch',result:'failure',code:safeCode(error,'COORDINATION_WATCH_FAILED'),durationMs:Date.now()-started}));
 };
}

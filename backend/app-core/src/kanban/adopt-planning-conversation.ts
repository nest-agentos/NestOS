import {channelRequests} from '../run/channel-protocol';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import type {KanbanPlanningSession} from '@nestos/kanban/contracts';
import {currentAnalysis,safeCode} from '@nestos/kanban/integration';
import {requireValue} from './validation';
/** Register observation of a verified retained planning Session; never create or relocate one. */
export function adoptPlanningConversation(options:DecisionConversationOptions,start:(board:string,request:{operationId:string})=>Promise<unknown>) {
 return async(board:string,item:string,session:KanbanPlanningSession):Promise<void>=>{
    const started=Date.now();
    const saved=await options.journal.get<DecisionConversation>('record-conversation:'+session.analysisId);
    const analysis=await currentAnalysis(options.journal,board,item);if(analysis?.id!==session.analysisId||analysis.phase!=='settled')return;
    const workspace=await options.journal.get<import('../presets/kanban-development').DevelopmentWorkspaceRecord>('development-workspace:'+session.analysisId);
    const context=workspace?.context as {decision?:{recordId:string;sourceBoardId:string}}|undefined;if(!workspace||!context?.decision||!session.resourceId)return;
    const choice=await options.journal.get<{profileId:string}>('kanban-harness-choice:'+session.analysisId);requireValue(choice,'KANBAN_HARNESS_BINDING_CHANGED');
    const channel=await options.remote.sessionChannel(workspace.projectId,'current',{cwd:workspace.directory}) as {scopeId:string;execution?:{sessionId?:string}};
    const native=channel.execution?.sessionId;requireValue(native&&session.resourceId.endsWith('/'+encodeURIComponent(choice.profileId)+'/'+encodeURIComponent(native)),'PLANNING_SOURCE_UNVERIFIED');
    requireValue(channel.scopeId,'CHANNEL_SCOPE_REQUIRED');if(saved?.binding.channelId===channel.scopeId&&saved.binding.retainedPlanning)return;
    const record=await options.service.record(context.decision.sourceBoardId,context.decision.recordId),harness=await options.remote.projectHarness(workspace.projectId);
    let epoch:string;try{epoch=(await harness.profiles()).epoch;}finally{await harness.close();}
    const workspaceId=options.remote.list(workspace.projectId).find(row=>row.at==='/')?.serverProjectId;requireValue(workspaceId,'DECISION_PROJECT_BINDING_CHANGED');
    const binding={id:session.analysisId,channelId:channel.scopeId,retainedPlanning:true as const,boardId:context.decision.sourceBoardId,purpose:'coordination' as const,recordId:record.id,projectId:workspace.projectId,
        projectIds:record.externalRefs?.filter(ref=>ref.system==='nestos-remote-project').map(ref=>ref.id),profileId:choice.profileId,workspaceId,directory:workspace.directory,epoch,createId:session.analysisId,inputId:session.analysisId};
    await retainAnsweredRequests(options,workspace.projectId,channel.scopeId);
    await options.journal.update<DecisionConversation>('record-conversation:'+session.analysisId,old=>old?{...old,binding}:{id:session.analysisId,boardId:binding.boardId,purpose:'coordination',recordId:record.id,state:'confirmed',phase:'submitting',submitted:true,createdAt:record.createdAt,sessionId:native,resourceId:session.resourceId,binding});
    options.log({operationId:session.analysisId,boardId:binding.boardId,stage:'coordination.session.adopt',result:'success',durationMs:Date.now()-started});
    void start(binding.boardId,{operationId:session.analysisId}).catch(error=>options.log({operationId:session.analysisId,boardId:binding.boardId,stage:'coordination.session.watch',result:'failure',code:safeCode(error,'COORDINATION_WATCH_FAILED'),durationMs:Date.now()-started}));
 };
}

export async function retainAnsweredRequests(options:DecisionConversationOptions,project:string,scope:string):Promise<void> {
    const requests=channelRequests(await options.remote.sessionChannel(project,'requests',{scopeId:scope}),scope);
    for(const row of requests)if(row.response){
        const key='decision-response:'+scope+':'+row.request.id;
        await options.journal.update(key,old=>old??row.response);
        await options.journal.update(key+':resumed',old=>old??true);
    }
}

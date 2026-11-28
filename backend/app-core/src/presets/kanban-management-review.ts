import {sha256HexSync,createModuleLogger} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
const log=createModuleLogger('kanban-management');
import type {KanbanBoard,KanbanCommand} from '@nestos/kanban/contracts';
import type {ReviewAdapter,ReviewJob,ReviewSnapshot} from '@nestos/kanban-development';
import {currentAnalysis,indexResourceJob} from '@nestos/kanban/integration';
import type {IndependentCallInput} from '@nestos/llm-session/contracts';
import type {PreparedWorktree} from '@nestos/git-delivery/worktrees';
import {requireValue} from '../kanban/validation';
import {developmentReviewAdapter,developmentReviewSnapshot,prepareDevelopmentReviewOperation,prepareReviewInResource,type DevelopmentReviewOptions} from './kanban-development-review';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import {kanbanGitIntegration,usesHostMergeProposal} from './kanban-git-integration';
import {verifyGitIntegration} from '@nestos/git-delivery/integration';
import type {GitSource,GitApproval} from '@nestos/git-delivery/contracts';
import {managedServiceDeployment,serviceDeploymentView} from './managed-service-deployment';
import {maintenanceInstruction} from './kanban-maintenance';
import {managementBatchSnapshot,managementBatch} from './kanban-management-snapshot';
import {freezeManagementScope,type ManagementScope} from './kanban-management-scope-catalog';
import {managementPrompts as prompts} from '@nestos/kanban-development';

/** Each repository uses the existing execution, receipt, cancellation and controller mechanisms. */
export function managementReviewAdapter(options:DevelopmentReviewOptions,scope:ManagementScope):ReviewAdapter {
    const base=developmentReviewAdapter(options);
    const snapshot=async(board:KanbanBoard)=>managementBatchSnapshot(scope,board,options.service,item=>developmentReviewSnapshot(options,board,item));
    const managed=managedServiceDeployment(options.serviceControl,async()=>serviceDeploymentView(await options.projects.openWorkspace((await options.projects.get(scope.projectId)).path),options.remote,scope.projectId),
        async job=>requireValue((await snapshot(await options.service.read(job.boardId))).version===job.snapshot.version,'OPERATION_SOURCE_CHANGED_REBUILD'));
    return {...base,managed,gitIntegration:kanbanGitIntegration(options, job => managementBatch(job.snapshot).sources.map(source => ({...source.snapshot.context as GitSource,taskId:source.itemId})),
        job=>{const {ownerId}=managementBatch(job.snapshot);requireValue(ownerId===scope.ownerId&&ownerId===job.itemId,'OPERATION_SCOPE_MISMATCH');return ownerId;}),
        runtimeVersion:async(_board,item)=>(await managed?.describe?.(item))?.version??base.runningVersion?.(),relatedSession:board=>managementSession(options,board.id,scope.ownerId),supports:(_board,item)=>item.id===scope.ownerId,
        ready:board=>scope.contributors.every(row=>board.items.some(item=>item.id===row.itemId&&['review','completed'].includes(item.status))),
        snapshot,prepareAnalysis:input=>prepareManagementOperation(options,scope,managed,{...input,action:'analyze'}),prepareOperation:input=>prepareManagementOperation(options,scope,managed,input),
        exchange:base.exchange?async(job,observation)=>{
            const frozen=managementBatch(job.snapshot);
            return base.exchange!({...job,itemId:frozen.sources[0].itemId,snapshot:frozen.sources[0].snapshot},observation,async()=>{
                const actual=await snapshot(await options.service.read(job.boardId));
                requireValue(actual.sourceVersion===job.snapshot.sourceVersion,'OPERATION_RESULT_SOURCE_CHANGED');
                requireValue(actual.version===job.snapshot.version,'MERGE_PLAN_SOURCE_CHANGED');
            });
        }:undefined,
        acceptanceCommands:board=>acceptanceCommands(options,scope,board),
        acceptanceVersion:undefined,readAnalysis:job=>readManagementOperation(options,scope,base,job),readOperation:job=>readManagementOperation(options,scope,base,job)};

}
async function prepareManagementOperation(options:DevelopmentReviewOptions,scope:ManagementScope,managed:ReviewAdapter['managed'],input:Parameters<NonNullable<ReviewAdapter['prepareOperation']>>[0]) {
    requireValue(input.item.id===scope.ownerId,'OPERATION_SCOPE_MISMATCH');
    await freezeManagementScope(options.journal,scope);
    const batch=managementBatch(input.snapshot);
    requireValue(batch.scopeId===scope.id&&batch.ownerId===input.item.id,'OPERATION_SCOPE_MISMATCH');
    const preparation={...input,
        ...(input.action==='build'?{deployment:await managed?.describe?.(input.item)}:{}),
        extraPrompts:Object.entries(prompts).map(([name,content])=>({name,content,sha256:sha256HexSync(content),source:'nestos-management-policy'}))};
    const integration=input.action==='analyze'||input.action==='merge';
    const workspace=integration?await managementWorkspace(options,scope):undefined;
    const request=workspace?await prepareReviewInResource(options,preparation,workspace):await prepareDevelopmentReviewOperation(options,
        {...preparation,item:(await options.service.item(input.board.id,batch.sources[0].itemId)).item});
    if(workspace)await indexResourceJob(options.journal,workspace.id,'review',input.id);
    for(const source of batch.sources){const id=(source.snapshot.context as {worktreeId?:string}).worktreeId;requireValue(id,'OPERATION_WORKSPACE_UNAVAILABLE');await indexResourceJob(options.journal,id,'review',input.id);}
    requireValue(request.source.kind==='composer','OPERATION_CONTEXT_SOURCE_INVALID');
    if(input.action==='analyze')return request;
    return {...request,source:{...request.source,text:maintenanceInstruction(input.action,['management-integration-pre.md'])}};
}
async function managementWorkspace(options:DevelopmentReviewOptions,scope:ManagementScope) {
    const analysis=await currentAnalysis<IndependentCallInput>(options.journal,scope.boardId,scope.ownerId);
    requireValue(analysis?.input.request.expectedSessionId===analysis?.id&&analysis?.id,'OPERATION_ORIGINAL_SESSION_UNAVAILABLE');
    const id=analysis.id;
    const [tree,record,cleanup]=await Promise.all([options.journal.get<PreparedWorktree>('worktree:'+id),
        options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+id),options.journal.get('worktree-cleanup:'+id)]);
    requireValue(tree&&record&&!cleanup&&tree.directory===record.directory&&record.projectId===scope.projectId,'OPERATION_WORKSPACE_UNAVAILABLE');
    const context=record.context as {board?:{id:string};task?:{id:string};snapshot?:unknown}|undefined;
    requireValue(context?.board?.id===scope.boardId&&context.task?.id===scope.ownerId,'OPERATION_WORKSPACE_SCOPE_MISMATCH');
    const {snapshot:_planningBoard,...operationContext}=context;
    return {id,tree,record:{...record,context:operationContext},planningCall:true as const};
}
async function managementSession(options:DevelopmentReviewOptions,boardId:string,itemId:string) {
    const analysis=await currentAnalysis<IndependentCallInput>(options.journal,boardId,itemId);
    if(!analysis)return;
    return (await options.calls.list({sessionId:analysis.id})).find(call=>call.input.request.submission?.id===analysis.id)?.receipt.executionSessionId;
}
async function readManagementOperation(options:DevelopmentReviewOptions,scope:ManagementScope,base:ReviewAdapter,job:ReviewJob):Promise<unknown|undefined> {
    const started=Date.now(),frozen=managementBatch(job.snapshot);requireValue(frozen.scopeId===scope.id&&frozen.ownerId===job.itemId,'OPERATION_SCOPE_MISMATCH');
    const definition=await options.service.read(job.boardId),actual=await managementBatchSnapshot(scope,definition,options.service,item=>developmentReviewSnapshot(options,definition,item));
    requireValue(actual.sourceVersion===job.snapshot.sourceVersion,'OPERATION_RESULT_SOURCE_CHANGED');
    if(job.action!=='merge'&&actual.version!==job.snapshot.version){
        const code=job.action==='analyze'?'MERGE_PLAN_SOURCE_CHANGED':'OPERATION_RESULT_SCOPE_MISMATCH';
        const previous=job.snapshot.context as {targetBranch?:string;targetWorktree?:{statusDigest?:string}};
        const current=actual.context as typeof previous;
        log.warn('Repository changed during operation',{operationId:job.id,scopeId:scope.id,stage:'management.snapshot.verify',result:'failure',code,action:job.action,
            expectedTargetVersion:job.snapshot.targetVersion,actualTargetVersion:actual.targetVersion,
            targetChanged:actual.targetVersion!==job.snapshot.targetVersion,targetBranchChanged:current.targetBranch!==previous.targetBranch,
            targetWorktreeChanged:current.targetWorktree?.statusDigest!==previous.targetWorktree?.statusDigest,durationMs:Date.now()-started});
        requireValue(false,code);
    }
    const result=await base.readOperation!({...job,itemId:frozen.sources[0].itemId,snapshot:frozen.sources[0].snapshot});
    if(job.action==='merge'&&result&&(result as {status?:string}).status==='succeeded'){
        if(await usesHostMergeProposal(options.journal,job)) {
            requireValue(actual.version===job.snapshot.version,'MERGE_PLAN_SOURCE_CHANGED');
            return result;
        }
        const started=Date.now();
        try{await verifyManagementMerge(options,job,actual,result);log.info('Repository batch verified',{operationId:job.id,scopeId:scope.id,stage:'management.merge.verify',result:'success',count:frozen.sources.length,durationMs:Date.now()-started});}
        catch(error){log.warn('Repository batch verification failed',{operationId:job.id,scopeId:scope.id,stage:'management.merge.verify',result:'failure',code:safeCode(error,'OPERATION_RESULT_BATCH_INCOMPLETE'),count:frozen.sources.length,durationMs:Date.now()-started});throw error;}
    }
    return result;
}
async function acceptanceCommands(options:DevelopmentReviewOptions,scope:ManagementScope,board:KanbanBoard):Promise<KanbanCommand[]> {
    const workflow=await options.service.workflow(board.id),commands:KanbanCommand[]=[];
    for(const source of scope.contributors){
        const {item}=await options.service.item(board.id,source.itemId);if(item.status==='completed')continue;
        const dispatch=source.dispatchId?workflow.dispatches[source.dispatchId]:undefined;
        requireValue(dispatch?.itemId===source.itemId&&dispatch.outcome==='succeeded','OPERATION_ACCEPTANCE_UNAVAILABLE');
        commands.push({type:'accept-execution',dispatchId:dispatch.id,accept:true});
    }
    return commands;
}
export async function verifyManagementMerge(options:Pick<DevelopmentReviewOptions,'remote'|'provider'>,job:ReviewJob,actual:ReviewSnapshot,result:unknown):Promise<void> {
    const batch=managementBatch(job.snapshot),target=(result as {targetHead?:string}).targetHead;
    await developmentWorkspace(options.remote,options.provider,batch.projectId,process=>verifyGitIntegration(process,{operationId:job.id,previousTarget:job.snapshot.targetVersion,
        actualTarget:actual.targetVersion,reportedTarget:target,sources:batch.sources.map(source=>source.snapshot.context as GitSource),approval:job.operationContext as GitApproval}));
}

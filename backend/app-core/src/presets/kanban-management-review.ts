import {sha256HexSync,createModuleLogger} from '@nestos/common';
import {safeCode} from '@nestos/kanban/integration';
const log=createModuleLogger('kanban-management');
import type {KanbanBoard,KanbanCommand} from '@nestos/kanban/contracts';
import type {ReviewAdapter,ReviewJob,ReviewSnapshot} from '../kanban/item-operation-types';
import {indexResourceJob} from '../kanban/resource-operation-index';
import {requireValue} from '../kanban/validation';
import {developmentReviewAdapter,developmentReviewSnapshot,prepareDevelopmentReviewOperation,type DevelopmentReviewOptions} from './kanban-development-review';
import {developmentWorkspace} from './kanban-development-workspace';
import {verifyGitIntegration} from '@nestos/git-delivery/integration';
import type {GitSource,GitApproval} from '@nestos/git-delivery/contracts';
import {managedServiceDeployment} from './managed-service-deployment';
import {maintenanceInstruction} from './kanban-maintenance';
import {managementBatchSnapshot,managementBatch} from './kanban-management-snapshot';
import {freezeManagementScope,type ManagementScope} from './kanban-management-scope-catalog';
import prompts from '../resources/kanban/kanban-management-prompts.json';

/** Each repository uses the existing execution, receipt, cancellation and controller mechanisms. */
export function managementReviewAdapter(options:DevelopmentReviewOptions,scope:ManagementScope):ReviewAdapter {
    const base=developmentReviewAdapter(options);
    const snapshot=async(board:KanbanBoard)=>managementBatchSnapshot(scope,board,options.service,item=>developmentReviewSnapshot(options,board,item));
    const managed=managedServiceDeployment(options.serviceControl,async()=>options.projects.openWorkspace((await options.projects.get(scope.projectId)).path),
        async job=>requireValue((await snapshot(await options.service.read(job.boardId))).version===job.snapshot.version,'OPERATION_SOURCE_CHANGED_REBUILD'));
    return {...base,managed,relatedSession:async(board)=>(await options.service.workflow(board.id)).dispatches[scope.contributors[0].dispatchId??'']?.executionSessionId,supports:(_board,item)=>item.id===scope.ownerId,
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
    const batch=managementBatch(input.snapshot),anchor=(await options.service.item(input.board.id,batch.sources[0].itemId)).item;
    requireValue(batch.scopeId===scope.id&&batch.ownerId===input.item.id,'OPERATION_SCOPE_MISMATCH');
    const request=await prepareDevelopmentReviewOperation(options,{...input,item:anchor,
        ...(input.action==='build'?{deployment:await managed?.describe?.(input.item)}:{}),
        extraPrompts:Object.entries(prompts).map(([name,content])=>({name,content,sha256:sha256HexSync(content),source:'nestos-management-policy'}))});
    for(const source of batch.sources){const id=(source.snapshot.context as {worktreeId?:string}).worktreeId;requireValue(id,'OPERATION_WORKSPACE_UNAVAILABLE');await indexResourceJob(options.journal,id,'review',input.id);}
    requireValue(request.source.kind==='composer','OPERATION_CONTEXT_SOURCE_INVALID');
    return {...request,source:{...request.source,text:maintenanceInstruction(input.action,['management-integration-pre.md'])}};
}
async function readManagementOperation(options:DevelopmentReviewOptions,scope:ManagementScope,base:ReviewAdapter,job:ReviewJob):Promise<unknown|undefined> {
    const frozen=managementBatch(job.snapshot);requireValue(frozen.scopeId===scope.id&&frozen.ownerId===job.itemId,'OPERATION_SCOPE_MISMATCH');
    const definition=await options.service.read(job.boardId),actual=await managementBatchSnapshot(scope,definition,options.service,item=>developmentReviewSnapshot(options,definition,item));
    requireValue(actual.sourceVersion===job.snapshot.sourceVersion,'OPERATION_RESULT_SOURCE_CHANGED');
    if(job.action!=='merge')requireValue(actual.version===job.snapshot.version,'OPERATION_RESULT_SCOPE_MISMATCH');
    const result=await base.readOperation!({...job,itemId:frozen.sources[0].itemId,snapshot:frozen.sources[0].snapshot});
    if(job.action==='merge'&&result&&(result as {status?:string}).status==='succeeded'){
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
    await developmentWorkspace(options.remote,options.provider,batch.projectId,process=>verifyGitIntegration(process,{previousTarget:job.snapshot.targetVersion,
        actualTarget:actual.targetVersion,reportedTarget:target,sources:batch.sources.map(source=>source.snapshot.context as GitSource),approval:job.operationContext as GitApproval}));
}

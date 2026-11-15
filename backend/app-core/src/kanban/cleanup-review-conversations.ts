import {managementScopeKey,type ManagementScope} from '../presets/kanban-management-scope-catalog';
import {sha256HexSync} from '@nestos/common';
import {cleanupReviewId,cleanupReviewInstruction,finishCleanupReview,type CleanupReviewInput,type ReviewJob} from '@nestos/kanban-development';
import {reviewCleanupKey,jobKey,safeCode,type ReviewCleanup} from '@nestos/kanban/integration';
import type {KanbanItemOperations} from '@nestos/kanban/contracts';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {requireValue} from './validation';
interface Saved {id:string;input:CleanupReviewInput;projectId:string;profileId:string;sessionId:string;channelId:string;resourceId:string;resources:Array<{id:string;itemId:string;location:string}>;context:unknown}
const savedKey=(id:string)=>'software-cleanup-review:'+id;
/** The native durable queue owns submission and recovery; these records only freeze authority and receipts. */
export async function requestManagementCleanup(options:DecisionConversationOptions,input:CleanupReviewInput,selected?:string[]):Promise<Saved> {
 const started=Date.now(),id=cleanupReviewId(input),saved=await options.journal.get<Saved>(savedKey(id));
 const review=saved??await freezeReview(options,id,input,selected);
 if(await options.journal.get('software-cleanup-submitted:'+id))return review;
 try {
 const port=await options.remote.projectConversation(review.projectId,review.profileId,review.sessionId);
 try{requireValue(port.enqueue,'NATIVE_QUEUE_UNSUPPORTED');await port.enqueue(cleanupReviewInstruction(review.context),[],undefined,'reply-'+id,'next-turn');}
 finally{await port.close();}
 await options.journal.update('decision-response:'+review.channelId+':'+id+':resumed',()=>true);
 await options.journal.update('software-cleanup-submitted:'+id,()=>true);
 options.log({operationId:input.operationId,boardId:input.boardId,stage:'cleanup.management.enqueue',result:'success',durationMs:Date.now()-started});return review;
 }catch(error){options.log({operationId:input.operationId,boardId:input.boardId,stage:'cleanup.management.enqueue',result:'failure',code:safeCode(error,'CLEANUP_MANAGEMENT_UNAVAILABLE'),durationMs:Date.now()-started});throw error;}
}
async function freeze(options:DecisionConversationOptions,id:string,input:CleanupReviewInput,selected?:string[]):Promise<Saved> {
 const client=options.client(),job=await options.journal.get<ReviewJob>(jobKey(input.runId));
 requireValue(job?.action==='merge'&&job.state==='succeeded'&&job.phase==='settled'&&job.boardId===input.boardId&&job.itemId===input.itemId&&job.scopeId===input.scopeId,'CLEANUP_REVIEW_SCOPE_INVALID');
 const management=(job.snapshot.context as {management?:{projectId:string;sources:Array<{itemId:string;snapshot:{sourceVersion:string;context:{worktreeId:string;directory:string;sourceHead:string;repositories:unknown[]}}}>}}).management;
 requireValue(management,'CLEANUP_REVIEW_SCOPE_INVALID');
 const session=await client.planningSession?.(input.boardId,input.itemId);requireValue(session?.resourceId,'MANAGEMENT_SESSION_NOT_READY');
 const retained=await options.journal.get<DecisionConversation>('record-conversation:'+session.analysisId);
 requireValue(retained?.sessionId&&retained.binding.retainedPlanning&&retained.resourceId===session.resourceId,'CLEANUP_REVIEW_SESSION_CHANGED');
 const rows=await client.workResources?.(input.boardId,input.itemId,{inspect:true})??[];
 const allowed=new Map(management.sources.map(source=>[source.snapshot.context.worktreeId,source]));
 const resources=rows.filter(row=>allowed.has(row.id)&&row.state!=='cleaned'&&(selected?selected.includes(row.id):!row.resolution));
 requireValue(!selected||selected.length>0&&selected.every(id=>resources.some(row=>row.id===id)),'CLEANUP_REVIEW_RESOURCE_INVALID');
 requireValue(resources.every(row=>row.ownership==='current'&&row.owner?.itemId===allowed.get(row.id)!.itemId&&row.location===allowed.get(row.id)!.snapshot.context.directory),'CLEANUP_REVIEW_RESOURCE_INVALID');
 const review:Saved={id,input,projectId:retained.binding.projectId,profileId:retained.binding.profileId,sessionId:retained.sessionId,channelId:retained.binding.channelId??retained.id,resourceId:session.resourceId,
  resources:resources.map(row=>({id:row.id,itemId:row.owner!.itemId,location:row.location})),context:{reviewId:id,boardId:input.boardId,itemId:input.itemId,scopeId:input.scopeId,cause:input.reviewCode??input.code,integratedCommit:(job.result as {targetHead?:string})?.targetHead,
   sources:management.sources.map(source=>({itemId:source.itemId,sourceVersion:source.snapshot.sourceVersion,worktreeId:source.snapshot.context.worktreeId,directory:source.snapshot.context.directory,sourceHead:source.snapshot.context.sourceHead,repositories:source.snapshot.context.repositories})),resources:resources.map(row=>({id:row.id,location:row.location,reasons:row.reasons,version:row.version})),protectedDirectory:retained.binding.directory}};
 return options.journal.update<Saved>(savedKey(id),old=>old??review);
}
export async function beginManagementCleanup(options:DecisionConversationOptions,conversation:DecisionConversation,params:Record<string,unknown>,requestId:string) {
 const itemId=params.itemId,scopeId=params.scopeId,selected=params.resourceIds;
 requireValue(typeof itemId==='string'&&typeof scopeId==='string'&&Array.isArray(selected)&&selected.length>0&&selected.length<=16&&selected.every(id=>typeof id==='string'),'CLEANUP_REVIEW_RESOURCE_INVALID');
 await boundItem(options,conversation,itemId);
 const view=await options.client().itemOperations!(conversation.boardId,itemId),scoped=scopeView(view,scopeId);
 requireValue(scoped.operations.some(row=>row.id==='accept'&&row.state==='succeeded'),'OPERATION_PREREQUISITE_REQUIRED');
 const merge=scoped.operations.find(row=>row.id==='merge');requireValue(merge?.runId,'OPERATION_PREREQUISITE_REQUIRED');
 const key=reviewCleanupKey(conversation.boardId,itemId,scopeId),old=await options.journal.get<ReviewCleanup>(key);
 const input:CleanupReviewInput={boardId:conversation.boardId,itemId,scopeId,runId:merge.runId,operationId:'cleanup-manager-'+sha256HexSync(JSON.stringify([conversation.id,requestId])).slice(0,48),attempt:(old?.attempt??0)+1,state:'running',reviewState:'pending',reviewCode:'WORKTREE_DIRTY'};
 const existing=await options.journal.get<Saved>(savedKey(cleanupReviewId(input)));
 const frozen=existing??await freeze(options,cleanupReviewId(input),input,selected as string[]);
 requireValue(frozen.sessionId===conversation.sessionId&&frozen.resourceId===conversation.resourceId,'CLEANUP_REVIEW_SESSION_CHANGED');
 const scope=await options.journal.get<ManagementScope>(managementScopeKey(scopeId));
 requireValue(scope?.boardId===conversation.boardId&&scope.ownerId===itemId,'OPERATION_SCOPE_INVALID');
 if(existing&&old?.reviewOperationId===input.operationId)return {reviewId:existing.id,state:old.state==='succeeded'?'completed':'reviewing',resourceId:existing.resourceId};
 requireValue(old?.reviewState!=='pending'||old.operationId===input.operationId,'CLEANUP_REVIEW_IN_PROGRESS');
 if(old?.operationId!==input.operationId){if(old)await options.journal.update('cleanup-review-history:'+old.operationId,value=>value??old);await options.journal.update(key,()=>frozen.input);}
 await options.journal.update<ManagementScope>(managementScopeKey(scopeId),value=>{requireValue(value?.ownerId===itemId&&value.boardId===conversation.boardId,'OPERATION_SCOPE_CHANGED');return {...value,stage:'accepted'};});
 const saved=await requestManagementCleanup(options,existing?.input??input,selected as string[]);
 return {reviewId:saved.id,state:'reviewing',resourceId:saved.resourceId};
}
async function boundItem(options:DecisionConversationOptions,conversation:DecisionConversation,item:string) {
 const record=await options.service.record(conversation.boardId,conversation.binding.recordId!),board=await options.service.read(conversation.boardId);
 requireValue(record.itemIds.includes(item)&&board.items.some(row=>row.id===item&&row.planning?.execution==='children'),'ITEM_NOT_IN_DECISION');
}
function scopeView(view:KanbanItemOperations,id:string):KanbanItemOperations {
 const result=view.scopes?.find(row=>row.id===id)?.view??view.plugins?.flatMap(plugin=>plugin.view.scopes??[]).find(row=>row.id===id)?.view;
 requireValue(result,'OPERATION_SCOPE_INVALID');return result;
}
async function boundReview(options:DecisionConversationOptions,conversation:DecisionConversation,id:unknown):Promise<Saved> {
 requireValue(typeof id==='string','CLEANUP_REVIEW_SCOPE_INVALID');const saved=await options.journal.get<Saved>(savedKey(id));
 requireValue(saved&&saved.sessionId===conversation.sessionId&&saved.resourceId===conversation.resourceId&&saved.input.boardId===conversation.boardId,'CLEANUP_REVIEW_SESSION_CHANGED');
 await boundItem(options,conversation,saved.input.itemId);return saved;
}
export async function readManagementCleanup(options:DecisionConversationOptions,conversation:DecisionConversation,id:unknown) {
 const saved=await boundReview(options,conversation,id);return {context:saved.context,status:await options.journal.get(reviewCleanupKey(saved.input.boardId,saved.input.itemId,saved.input.scopeId))};
}
export async function completeManagementCleanup(options:DecisionConversationOptions,conversation:DecisionConversation,id:unknown) {
 const started=Date.now(),saved=await boundReview(options,conversation,id),client=options.client(),input=saved.input;
 const current=await options.journal.get<ReviewCleanup>(reviewCleanupKey(input.boardId,input.itemId,input.scopeId));
 requireValue(current&&[current.operationId,current.reviewOperationId].includes(input.operationId)&&current.runId===input.runId,'CLEANUP_REVIEW_CHANGED');
 if(current.state==='succeeded')return {state:'completed',resources:saved.resources.map(row=>row.id)};
 const rows=await client.workResources!(input.boardId,input.itemId,{inspect:true}),residual:Array<{id:string;code:string}>=[];
 for(const expected of saved.resources){const row=rows.find(row=>row.id===expected.id);requireValue(row&&row.owner?.itemId===expected.itemId&&row.location===expected.location,'CLEANUP_REVIEW_RESOURCE_CHANGED');
  if(row.state==='cleaned')continue;
  if(!row.canCleanup&&!(row.resolution?.kind==='ignored'&&row.ownership==='current'&&!row.reasons.length)){residual.push({id:row.id,code:row.reasons[0]??'WORKTREE_CLEANUP_BLOCKED'});continue;}
  try{const cleaned=await client.cleanupWorkResource!(input.boardId,{itemId:expected.itemId,resourceId:row.id,version:row.version,operationId:'cleanup-reviewed-'+sha256HexSync(JSON.stringify([saved.id,row.id])).slice(0,40)});
   if(cleaned.state!=='cleaned')residual.push({id:row.id,code:cleaned.reasons[0]??'WORKTREE_CLEANUP_UNCONFIRMED'});
  }catch(error){residual.push({id:row.id,code:safeCode(error,'WORKTREE_CLEANUP_UNCONFIRMED')});}
 }
 await finishCleanupReview(options.journal,input);
 options.log({operationId:input.operationId,boardId:input.boardId,stage:'cleanup.management.verify',result:residual.length?'failure':'success',code:residual[0]?.code,durationMs:Date.now()-started});
 if(residual.length){await options.journal.update<ReviewCleanup>(reviewCleanupKey(input.boardId,input.itemId,input.scopeId),old=>({...old!,state:'failed',code:residual[0].code}));return {state:'blocked',residual};}
 const root=await client.itemOperations!(input.boardId,input.itemId),view=scopeView(root,input.scopeId!);
 await client.runItemOperation!(input.boardId,{itemId:input.itemId,scopeId:input.scopeId,pluginId:root.pluginId,operationId:'finish-'+saved.id,action:'cleanup',expectedRevision:view.revision});
 const status=await options.journal.get<ReviewCleanup>(reviewCleanupKey(input.boardId,input.itemId,input.scopeId));
 return {state:status?.state==='succeeded'?'completed':status?.state==='failed'?'blocked':'pending',code:status?.code,resources:saved.resources.map(row=>row.id)};
}

async function freezeReview(options:DecisionConversationOptions,id:string,input:CleanupReviewInput,selected?:string[]):Promise<Saved>{
 try{return await freeze(options,id,input,selected);}
 catch(error){
  const code=safeCode(error,'CLEANUP_REVIEW_UNAVAILABLE');
  if(['CLEANUP_REVIEW_SCOPE_INVALID','CLEANUP_REVIEW_SESSION_CHANGED','CLEANUP_REVIEW_RESOURCE_INVALID','MANAGEMENT_SESSION_NOT_READY'].includes(code))throw Object.assign(Error(code),{code,cleanupReviewUnavailable:true});
  throw error;
 }
}

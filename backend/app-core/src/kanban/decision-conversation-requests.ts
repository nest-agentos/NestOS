import {confirmRecordExecution,itemsWithinRoots,itemWithinRoots} from '@nestos/kanban/integration';
import {conversationIssuesKey,conversationIssueView,type ConversationIssueState} from '../run/conversation-issues';
import {requireUserConfirmation} from './decision-conversation-confirmation';
import {cancelDecisionConversation,conversationCancellationState} from './decision-conversation-cancellation';
import {conversationPolicy} from './conversation-policy';
import {kanbanVerificationOptions,type KanbanRecordInput,type KanbanCommand} from '@nestos/kanban/contracts';
import {journalCommand} from '@nestos/kanban/integration';
import {channelDigest,type ChannelRequest} from '../run/channel-protocol';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
import {validateRemoteReferences,REMOTE_PROJECT_REFERENCE,PRIMARY_PROJECT_REFERENCE} from './resource-catalog';
import {requireValue} from './validation';
import {decisionProjectScope} from './decision-project-scope';
interface Link {recordId:string;state:'draft'|'confirmed';proposalDigest:string}
interface Proposal {record:KanbanRecordInput;proposalDigest:string}
const proposalKey=(id:string)=>'decision-conversation-proposal:'+id;
const linkKey=(id:string)=>'decision-conversation-record:'+id;

/** A channel is scoped to one board and one decision; model IDs cannot select another decision. */
export async function resolveDecisionRequest(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest):Promise<unknown> {
    const link=await options.journal.get<Link>(linkKey(conversation.id)),board=await options.service.read(conversation.boardId);
    requireValue(!board.lifecycle&&!board.deletedAt,'BOARD_STOPPING');
    if(request.method==='decision.read') {
        const record=link?await options.service.record(board.id,link.recordId):null,proposal=await options.journal.get<Proposal>(proposalKey(conversation.id));
        const selected=request.params.itemIds;
        requireValue(selected===undefined||Array.isArray(selected)&&selected.length<=1&&selected.every(id=>typeof id==='string'),'INVALID_DETAIL_SELECTION');
        const tasks=record?itemsWithinRoots(board.items,record.itemIds,{includeDeleted:true}):[];
        return {conversationId:conversation.id,...await decisionConversationState(options,conversation.id,board.id),actions:{cancel:{method:'decision.cancel',params:{},confirmation:(await conversationPolicy(options.fs)).cancelDecision}},projectIds:conversation.binding.projectIds,conversationProjectId:conversation.binding.projectId,board:{id:board.id,title:board.title},record,...(!link&&proposal?{proposal}:{}),total:tasks.length,
            tasks:(Array.isArray(selected)?tasks.filter(item=>selected.includes(item.id)):tasks.slice(0,50)).map(item=>({id:item.id,title:item.title.slice(0,160),status:item.status,revision:item.revision,projectIds:item.externalRefs?.filter(ref=>ref.system===REMOTE_PROJECT_REFERENCE).map(ref=>ref.id)??[],admittedAt:item.launch?.admittedAt,editing:item.launch?.editing,
                ...(Array.isArray(selected)&&selected.includes(item.id)?{responsibility:item.responsibility,acceptance:item.acceptance,planning:item.planning}:{})}))};
    }
    if(request.method==='decision.cancel')return cancelDecisionConversation(options,conversation,request,link);
    const state=await conversationCancellationState(options,conversation.id);
    requireValue(!state,state?.state==='cancelling'?'DECISION_CONVERSATION_CANCELLING':'DECISION_CONVERSATION_CANCELLED');
    const reports=conversationIssueView(await options.journal.get<ConversationIssueState>(conversationIssuesKey(conversation.id)));
    requireValue(!reports.pendingReports.length||request.method==='decision.cancel-edit','DECISION_SESSION_BLOCKED');
    if(request.method==='decision.propose')return propose(options,conversation,request);
    if(request.method==='decision.confirm')return confirm(options,conversation,request,link);
    requireValue(link,'DECISION_PROPOSAL_REQUIRED');
    if(request.method==='decision.begin-edit'||request.method==='decision.apply-edit'||request.method==='decision.cancel-edit')return reviseTasks(options,conversation,request,link);
    if(request.method==='decision.open-coordination')return openCoordination(options,conversation,request,link);
    throw Object.assign(new Error('Unsupported decision request'),{code:'DECISION_REQUEST_UNSUPPORTED'});
}
async function command(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,value:KanbanCommand):Promise<void> {
    for(let attempt=0;attempt<3;attempt++){
        requireValue(options.active?.()!==false,'SERVICE_STOPPING');
        try{await journalCommand(options.journal,options.service,conversation.boardId,'decision-command:'+conversation.id+':'+request.id+':'+value.type,value);return;}
        catch(error){if((error as {code?:string}).code!=='REVISION_CONFLICT'||attempt===2)throw error;}
    }
}
async function propose(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest) {
    const value=request.params as {id:string;title:string;content:string;rationale:string;projectIds:string[];verificationMode:string};
    requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.id)&&Array.isArray(value.projectIds)&&value.projectIds.length>0&&value.projectIds.length<=16,'DECISION_PROPOSAL_INVALID');
    requireValue(new Set(value.projectIds).size===value.projectIds.length,'DECISION_PROPOSAL_INVALID');
    const scope=conversation.binding.projectIds;
    requireValue(!scope||scope.length===value.projectIds.length&&value.projectIds.every(id=>scope.includes(id)),'DECISION_PROJECT_SCOPE_MISMATCH');
    const externalRefs=value.projectIds.map(id=>({system:REMOTE_PROJECT_REFERENCE,id}));await validateRemoteReferences(options.projects,{externalRefs});
    if(scope){decisionProjectScope(options.remote,conversation.binding.projectId,scope);externalRefs.push({system:PRIMARY_PROJECT_REFERENCE,id:conversation.binding.projectId});}
    const selected=kanbanVerificationOptions(value.verificationMode),record:KanbanRecordInput={id:value.id,kind:'decision',completion:'automatic',title:value.title,content:value.content,rationale:value.rationale,itemIds:[],externalRefs,discussionSessionId:conversation.resourceId,...selected,
        sources:[{sessionId:conversation.resourceId!,messageId:request.id,revision:channelDigest(request),role:'assistant'}]};
    const previous=await options.journal.get<Link>(linkKey(conversation.id));requireValue(!previous,'DECISION_ALREADY_CONFIRMED');
    requireValue([value.title,value.content,value.rationale].every(text=>typeof text==='string'&&text.trim().length>0),'DECISION_PROPOSAL_INVALID');
    const proposal={record,proposalDigest:channelDigest(record)};
    await options.journal.update<Proposal>(proposalKey(conversation.id),old=>{requireValue(!old||old.record.id===value.id,'DECISION_ID_IMMUTABLE');return proposal;});
    return {state:'draft',...proposal,confirmation:(await conversationPolicy(options.fs)).confirmDecision};
}
async function confirm(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,previous?:Link) {
    const proposal=await options.journal.get<Proposal>(proposalKey(conversation.id)),digest=previous?.proposalDigest??proposal?.proposalDigest;
    requireValue(digest,'DECISION_PROPOSAL_REQUIRED');requireValue(request.params.proposalDigest===digest,'DECISION_PROPOSAL_CHANGED');
    await requireUserConfirmation(options,conversation,request,(await conversationPolicy(options.fs)).confirmDecision);
    let link=previous;
    if(!link){
        requireValue(proposal,'DECISION_PROPOSAL_REQUIRED');
        if(conversation.binding.projectIds)decisionProjectScope(options.remote,conversation.binding.projectId,conversation.binding.projectIds);
        await validateRemoteReferences(options.projects,{externalRefs:proposal.record.externalRefs});
        await command(options,conversation,request,{type:'append-record',record:proposal.record});
        link=await options.journal.update<Link>(linkKey(conversation.id),()=>({recordId:proposal.record.id,state:'draft',proposalDigest:digest}));
    }
    const client=options.client();requireValue(client.runRecord,'RECORD_EXECUTION_UNAVAILABLE');
    const recordId=link.recordId;
    const run=await confirmRecordExecution(options.service,options.journal,{boardId:conversation.boardId,recordId,runKey:'decision-run-request:'+conversation.id,runOperationId:'decision-run-'+conversation.id,
        active:()=>options.active?.()!==false,commit:value=>command(options,conversation,request,value),
        confirmed:async()=>{await options.journal.update<Link>(linkKey(conversation.id),old=>({...old!,state:'confirmed'}));},run:frozen=>client.runRecord!(conversation.boardId,frozen)});
    return {recordId,state:'confirmed',execution:run};
}
async function reviseTasks(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,link:Link) {
    const record=await options.service.record(conversation.boardId,link.recordId),value=request.params as {editId:string;recordRevision:number;items:any[];title:string;content:string;rationale:string};
    requireValue(record.status==='confirmed','DECISION_NOT_CONFIRMED');
    requireValue(typeof value.editId==='string'&&value.editId.startsWith(conversation.id+'-'),'EDIT_SCOPE_MISMATCH');
    const type=request.method==='decision.begin-edit'?'begin-record-edit':request.method==='decision.apply-edit'?'save-record-edit':'end-record-edit';
    if(type==='save-record-edit')await requireUserConfirmation(options,conversation,request,(await conversationPolicy(options.fs)).confirmAdjustment);
    await command(options,conversation,request,{...value,type,recordId:link.recordId} as KanbanCommand);
    const board=await options.service.read(conversation.boardId),ids=value.items.map(row=>typeof row==='string'?row:row.id);
    return {record:await options.service.record(board.id,link.recordId),blocked:type==='begin-record-edit',items:board.items.filter(row=>ids.includes(row.id)).map(row=>({id:row.id,revision:row.revision,title:row.title,editing:row.launch?.editing}))};
}
async function openCoordination(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,link:Link) {
    const value=request.params as {itemId:string},board=await options.service.read(conversation.boardId),record=await options.service.record(board.id,link.recordId);
    const coordination=options.client().openRecordCoordination;
    if(coordination){if(value.itemId)requireValue(itemWithinRoots(board.items,value.itemId,record.itemIds),'ITEM_NOT_IN_DECISION');return coordination(board.id,{recordId:record.id,operationId:'decision-coordinate-'+request.id});}
    requireValue(itemWithinRoots(board.items,value.itemId,record.itemIds),'ITEM_NOT_IN_DECISION');
    const item=board.items.find(row=>row.id===value.itemId),group=item?.planning?.execution==='children'?item:board.items.find(row=>row.id===item?.planning?.parentId);
    requireValue(group?.planning?.execution==='children','REPAIR_GROUP_REQUIRED');
    const client=options.client();requireValue(client.fixTask,'FIX_UNAVAILABLE');
    const fix=await client.fixTask(board.id,{itemId:group.id,operationId:'decision-coordinate-'+request.id});
    return {groupItemId:group.id,state:'clarifying',sessionId:fix.sessionId,resourceId:await options.executionResource?.(fix.sessionId,'main',board)??fix.sessionId};
}

export async function decisionConversationState(options:DecisionConversationOptions,id:string,boardId?:string) {
    const cancellation=await conversationCancellationState(options,id);if(cancellation)return cancellation;
    const link=await options.journal.get<Link>(linkKey(id));
    if(link&&boardId){const record=await options.service.record(boardId,link.recordId);if(record.status==='cancelled'||record.status==='cancelling')return {recordId:link.recordId,state:record.status};}
    const reports=conversationIssueView(await options.journal.get<ConversationIssueState>(conversationIssuesKey(id)));
    return {...(link??{state:await options.journal.get<Proposal>(proposalKey(id))?'draft' as const:'clarifying' as const}),...reports};
}

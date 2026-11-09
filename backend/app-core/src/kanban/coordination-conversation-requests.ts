import {conversationPolicy} from './conversation-policy';
import {sha256HexSync} from '@nestos/common';
import {commitCollaboration,itemsWithinRoots,journalCommand,type Definition} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanProjectRecord} from '@nestos/kanban/contracts';
import {conversationIssueView,conversationIssuesKey,type ConversationIssueState} from '../run/conversation-issues';
import {channelDigest,type ChannelRequest} from '../run/channel-protocol';
import {requireUserConfirmation} from './decision-conversation-confirmation';
import {coordinationProposal} from './coordination-proposal';
import {requireValue} from './validation';
import type {DecisionConversationOptions,DecisionConversation} from './decision-conversation-ports';
interface Proposal {id:string;itemId:string;definition:Definition;digest:string}
/** All targets are checked against this decision; native user evidence gates every new follow-up. */
export async function resolveCoordinationRequest(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest) {
    const board=await options.service.read(conversation.boardId),record=await options.service.record(board.id,conversation.binding.recordId!);
    const tasks=itemsWithinRoots(board.items,record.itemIds),reports=conversationIssueView(await options.journal.get<ConversationIssueState>(conversationIssuesKey(conversation.id)));
    if(request.method==='coordination.read')return JSON.parse(JSON.stringify({record,groups:tasks.filter(item=>item.purpose==='planning'||item.planning?.execution==='children').map(item=>({id:item.id,title:item.title,revision:item.revision,projectIds:item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project').map(ref=>ref.id),retryPlanning:item.analysis?.state==='failed'&&!item.owner&&!['completed','cancelled'].includes(item.status)})),
        tasks:tasks.map(item=>({id:item.id,title:item.title,status:item.status,revision:item.revision,parentId:item.planning?.parentId,analysis:item.analysis,blocked:item.blocked,acceptanceResult:item.acceptanceResult,operationWaivers:item.operationWaivers})),...reports}));
    requireValue(!board.lifecycle&&!board.deletedAt&&record.status==='confirmed'&&record.archivedAt===undefined,'DECISION_NOT_ACTIVE');
    requireValue(!reports.pendingReports.length,'DECISION_SESSION_BLOCKED');
    if(request.method==='coordination.retry-planning'){
        const item=tasks.find(row=>row.id===request.params.itemId);
        requireValue(item&&(item.purpose==='planning'||item.planning?.execution==='children'),'ITEM_NOT_IN_DECISION');
        const operationId='coordinate-retry-'+sha256HexSync(JSON.stringify([conversation.id,request.id]));
        if(!await options.journal.get(operationId+':authorized')){requireValue(item.revision===request.params.revision,'REVISION_CONFLICT');await options.journal.update(operationId+':authorized',()=>({itemId:item.id,revision:item.revision}));}
        await journalCommand(options.journal,options.service,board.id,operationId,{type:'retry-analysis',itemId:item.id,retryId:operationId});
        return {itemId:item.id,state:'retry-requested'};
    }
    if(request.method==='coordination.propose-fix')return propose(options,conversation,request,board,record);
    if(request.method==='coordination.confirm-fix')return confirm(options,conversation,request,board,record);
    throw Object.assign(new Error('Unsupported coordination request'),{code:'COORDINATION_REQUEST_UNSUPPORTED'});
}
async function propose(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,board:KanbanBoard,record:KanbanProjectRecord){
    const item=itemsWithinRoots(board.items,record.itemIds).find(row=>row.id===request.params.itemId);
    requireValue(item?.planning?.execution==='children','ITEM_NOT_IN_DECISION');
    const id='coordinate-fix-'+sha256HexSync(JSON.stringify([conversation.id,request.id]));
    const definition=JSON.parse(JSON.stringify(coordinationProposal(request.params.proposal,{id,itemId:item.id,item} as never,board))) as Definition,digest=channelDigest({itemId:item.id,definition});
    const saved=await options.journal.update<Proposal>('coordination-proposal:'+id,old=>old??{id,itemId:item.id,definition,digest});
    requireValue(saved.digest===digest,'CHANNEL_REQUEST_CHANGED');
    await options.journal.update('coordination-proposal-owner:'+id,old=>old??conversation.id);
    return {proposalId:id,proposalDigest:digest,definition,confirmation:(await conversationPolicy(options.fs)).confirmFix};
}
async function confirm(options:DecisionConversationOptions,conversation:DecisionConversation,request:ChannelRequest,board:KanbanBoard,record:KanbanProjectRecord){
    const proposal=await options.journal.get<Proposal>('coordination-proposal:'+String(request.params.proposalId));
    requireValue(proposal&&proposal.digest===request.params.proposalDigest,'FIX_PROPOSAL_REQUIRED');
    requireValue(await options.journal.get('coordination-proposal-owner:'+proposal.id)===conversation.id,'ITEM_NOT_IN_DECISION');
    const item=itemsWithinRoots(board.items,record.itemIds).find(item=>item.id===proposal.itemId);requireValue(item,'ITEM_NOT_IN_DECISION');
    const projects=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
    requireValue(proposal.definition.children?.every(child=>JSON.stringify(child.externalRefs?.filter(ref=>ref.system==='nestos-remote-project'))===JSON.stringify(projects)),'FIX_PROJECT_CHANGED');
    if(!await options.journal.get('coordination-confirmation:'+proposal.id)){await requireUserConfirmation(options,conversation,request,(await conversationPolicy(options.fs)).confirmFix,'FIX_USER_CONFIRMATION_REQUIRED');await options.journal.update('coordination-confirmation:'+proposal.id,()=>({requestId:request.id,digest:proposal.digest}));}
    const definition=proposal.definition,plan={schema:'kanban.plan/1' as const,id:proposal.id,revision:1,sealed:true,mode:'append' as const,rootItemId:proposal.itemId,items:definition.children!};
    await commitCollaboration(options.service,options.journal,{id:proposal.id,boardId:board.id,itemId:proposal.itemId,commandKey:'coordination-confirm:'+proposal.id,children:definition.children,repairItemId:definition.repair?.itemId,repairAfterCommit:true,command:definition.repair?{type:'insert-repair-dependency',itemId:definition.repair.itemId,expectedItemRevision:definition.repair.revision,plan}:{type:'publish-plan',plan}});
    return {state:'accepted',itemIds:plan.items.map(item=>item.id)};
}

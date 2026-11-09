import {channelDigest} from './channel-protocol';
import {failure,type PromptJournal} from './prompt-bundle';
interface Origin {sessionId:string;turnId:string;operationId?:string}
interface Publication {id:string;message:{type:string;content:string;replyTo?:string;payload?:{handler?:'self'|'parent'}};origin?:Origin|null}
export interface ConversationIssueState {seen:Record<string,string>;issues:Record<string,{type:'error'|'clarification';origin:Origin;handler?:'self'|'parent'}>;resolved:string[];rejected:Record<string,string>;acknowledged:string[]}
export const conversationIssuesKey=(scopeId:string)=>'conversation-issues:'+scopeId;
export function conversationIssueView(state?:ConversationIssueState) {
    const pendingReports=Object.entries(state?.issues??{}).filter(([id])=>!state?.resolved.includes(id)).map(([id,issue])=>({id,type:issue.type,...(issue.handler?{handler:issue.handler}:{})}));
    const code=pendingReports.length?pendingReports.some(issue=>issue.type==='error')?'DECISION_SESSION_ERROR_REPORTED':'DECISION_SESSION_INPUT_REQUIRED':undefined;
    return {...(pendingReports.length?{state:'blocked' as const}:{}),code,pendingReports};
}
/** Report origins come from Cells. Resolving an error is not a final result or a user approval. */
export async function readConversationIssues(remote:{sessionChannel(project:string,operation:string,args:Record<string,unknown>):Promise<unknown>},project:string,scope:string,sessionId:string,journal:PromptJournal) {
    const value=await remote.sessionChannel(project,'messages',{scopeId:scope}) as {messages?:Publication[]};
    if(!Array.isArray(value?.messages)||value.messages.length>200||value.messages.some(row=>!row||typeof row.id!=='string'||!row.message||typeof row.message.type!=='string'))throw failure('CHANNEL_MESSAGES_INVALID');
    const rows=value.messages.filter(row=>['error','clarification','resolved'].includes(row.message?.type));
    const key=conversationIssuesKey(scope),empty:ConversationIssueState={seen:{},issues:{},resolved:[],rejected:{},acknowledged:[]};
    let state=await journal.update<ConversationIssueState>(key,old=>freeze(old??empty,rows,sessionId));
    for(const row of rows){
        if(state.acknowledged.includes(row.id))continue;
        const ack=state.rejected[row.id]?{status:'rejected',code:state.rejected[row.id]}:{status:row.message.type==='resolved'?'validated':'waiting-input'};
        await remote.sessionChannel(project,'acknowledge',{scopeId:scope,id:row.id,ack:{...ack,scopeId:scope,messageId:row.id}});
        state=await journal.update<ConversationIssueState>(key,old=>({...old!,acknowledged:[...new Set([...old!.acknowledged,row.id])]}));
    }
    return conversationIssueView(state);
}
function freeze(state:ConversationIssueState,rows:Publication[],sessionId:string):ConversationIssueState {
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw failure('CHANNEL_MESSAGES_INVALID');
    if(Object.keys(state.seen).some(id=>!rows.some(row=>row.id===id)))throw failure('CHANNEL_MESSAGE_MISSING');
    const next=structuredClone(state);
    for(const row of rows){
        if(!/^[\w-]{1,128}$/.test(row.id)||typeof row.message.content!=='string'||!row.message.content.trim()||row.message.content.length>8000)throw failure('CHANNEL_MESSAGE_INVALID');
        const digest=channelDigest(row);if(next.seen[row.id]&&next.seen[row.id]!==digest)throw failure('CHANNEL_MESSAGE_CHANGED');next.seen[row.id]=digest;
        if(row.message.type!=='resolved'){
            if(!row.origin?.operationId||!row.origin.turnId||row.origin.sessionId!==sessionId)throw failure('CONVERSATION_SOURCE_UNVERIFIED');
            if(row.message.payload?.handler!==undefined&&!['self','parent'].includes(row.message.payload.handler))throw failure('CONVERSATION_HANDLER_INVALID');
            next.issues[row.id]??={...(row.message.payload?.handler?{handler:row.message.payload.handler}:{}),type:row.message.type as 'error'|'clarification',origin:{...row.origin}};
        }
    }
    for(const row of rows.filter(row=>row.message.type==='resolved')){
        if(next.rejected[row.id])continue;
        const issue=next.issues[row.message.replyTo??''];
        if(!issue||!row.origin?.operationId||!row.origin.turnId||row.origin.sessionId!==sessionId||(issue.type==='clarification'&&issue.origin.turnId===row.origin.turnId)){next.rejected[row.id]='CONVERSATION_RESOLUTION_UNVERIFIED';continue;}
        if(!next.resolved.includes(row.message.replyTo!))next.resolved.push(row.message.replyTo!);
    }
    return next;
}

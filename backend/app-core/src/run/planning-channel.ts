import {channelDigest} from './channel-protocol';
import {failure,type PromptJournal} from './prompt-bundle';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {KanbanAnalysisObservation} from '@nestos/kanban/integration';
interface Origin {sessionId:string;turnId:string;operationId?:string;revision?:number}
interface Message {id:string;message:{type:string;content:string;replyTo?:string;payload?:{ready?:boolean;reason?:string;handler?:'self'|'parent'}};origin?:Origin|null}
interface State {seen:Record<string,string>;questions:Record<string,Origin>;errors?:Record<string,Origin>;resolved:string[];acknowledged?:string[];rejected?:Record<string,string>;blockingQuestions?:Record<string,string[]>;final?:{id:string;digest:string}}
interface Envelope {messages:Message[];execution?:Origin & {status?:string}}
type Remote=Pick<ProjectRemoteMountService,'sessionChannel'>;

/** Publication evidence is supplied by Cells, never by model-authored message fields. */
export async function readPlanningChannel(remote:Remote,projectId:string,scopeId:string,journal:PromptJournal,validate?:(output:unknown)=>void):Promise<KanbanAnalysisObservation|undefined> {
    const value=await remote.sessionChannel(projectId,'messages',{scopeId}) as Envelope;
    if(!Array.isArray(value?.messages)||value.messages.length>200||value.messages.some(row=>!row||typeof row.id!=='string')||new Set(value.messages.map(row=>row.id)).size!==value.messages.length)throw failure('CHANNEL_MESSAGES_INVALID');
    const key='planning-conversation:'+scopeId;
    let state=await journal.get<State>(key)??{seen:{},questions:{},resolved:[]};
    state=await journal.update<State>(key,old=>freezePublications(old??state,value));
    for(const row of value.messages){
        if(state.acknowledged?.includes(row.id))continue;
        if(state.questions[row.id]||state.errors?.[row.id])await acknowledge(remote,projectId,scopeId,row.id,'waiting-input');
        else if(state.rejected?.[row.id])await remote.sessionChannel(projectId,'acknowledge',{scopeId,id:row.id,ack:{status:'rejected',code:state.rejected[row.id],...(state.blockingQuestions?.[row.id]?{pendingQuestionIds:state.blockingQuestions[row.id]}:{})}});
        else if(row.message.type==='resolved'&&state.resolved.includes(row.message.replyTo??''))await acknowledge(remote,projectId,scopeId,row.id,'validated');
        else continue;
        state=await journal.update<State>(key,old=>({...old!,acknowledged:[...new Set([...old?.acknowledged??[],row.id])]}));
    }
    if(!state.final&&['failed','interrupted','rejected'].includes(value.execution?.status??''))return {state:'failed',code:'PLANNING_EXECUTION_FAILED'};
    if(!state.final&&value.execution?.status==='cancelled')return {state:'cancelled',code:'PLANNING_EXECUTION_CANCELLED'};
    const final=value.messages.filter(row=>row.message.type==='result'&&row.message.payload?.ready===true&&!state.rejected?.[row.id]);
    if(final.length>1)throw failure('CHANNEL_RESULT_INVALID');
    if(final.length){const row=final[0];
        if(pendingIds(state).length>0)return clarification(value,state);
        if(!state.final&&!terminal(value,row))return {state:'running'};
        try{validate?.(row.message.payload);}catch(error){
            const code=(error as {code?:string}).code??'PLANNING_RESULT_INVALID';
            await journal.update<State>(key,old=>({...old!,rejected:{...old?.rejected,[row.id]:code}}));
            await remote.sessionChannel(projectId,'acknowledge',{scopeId,id:row.id,ack:{status:'rejected',code}});
            return {state:'clarification',reason:code};
        }
        const digest=channelDigest(row.message.payload);
        state=await journal.update<State>(key,old=>{if(old?.final&&(old.final.id!==row.id||old.final.digest!==digest))throw failure('CHANNEL_RESULT_CHANGED');return {...old!,final:{id:row.id,digest}};});
        await acknowledge(remote,projectId,scopeId,row.id,'validated');
        return {state:'succeeded',output:row.message.payload};
    }
    return clarification(value,state);
}
function freezePublications(state:State,value:Envelope):State {
    if(Object.keys(state.seen).some(id=>!value.messages.some(row=>row.id===id)))throw failure('CHANNEL_MESSAGE_MISSING');
    const next=structuredClone(state);
    for(const row of value.messages){
        if(!row||typeof row.id!=='string'||!row.message||typeof row.message.content!=='string')throw failure('CHANNEL_MESSAGE_INVALID');
        const digest=channelDigest(row);if(next.seen[row.id]&&next.seen[row.id]!==digest)throw failure('CHANNEL_MESSAGE_CHANGED');
        next.seen[row.id]=digest;
        if(row.message.type==='clarification'||row.message.type==='result'&&row.message.payload?.ready===false){
            const origin=row.origin??value.execution;
            if(!next.questions[row.id]){if(!origin?.sessionId||!origin.turnId)throw failure('PLANNING_SOURCE_UNVERIFIED');next.questions[row.id]={...origin};}
        }
        if(['error','clarification'].includes(row.message.type)&&row.message.payload?.handler!==undefined&&!['self','parent'].includes(row.message.payload.handler))throw failure('PLANNING_HANDLER_INVALID');
        if(row.message.type==='error'){const origin=row.origin;if(!origin?.sessionId||!origin.turnId||!origin.operationId)throw failure('PLANNING_SOURCE_UNVERIFIED');next.errors??={};next.errors[row.id]??={...origin};}
        if(row.message.type==='result'&&typeof row.message.payload?.ready!=='boolean')throw failure('AUTOMATION_ANALYSIS_INVALID');
        if(row.message.type==='resolved'&&!next.rejected?.[row.id]){
            const issueId=row.message.replyTo??'',question=next.questions[issueId]??next.errors?.[issueId];
            if(!question||!row.origin||question.sessionId!==row.origin.sessionId||(!next.errors?.[issueId]&&question.turnId===row.origin.turnId)
                ||!row.origin.turnId||!row.origin.operationId){next.rejected??={};next.rejected[row.id]='PLANNING_REPLY_UNVERIFIED';continue;}
            if(!next.resolved.includes(row.message.replyTo!))next.resolved.push(row.message.replyTo!);
        }
        if(row.message.type==='result'&&row.message.payload?.ready===true&&pendingIds(next).length){next.rejected??={};next.rejected[row.id]=Object.keys(next.errors??{}).some(id=>!next.resolved.includes(id))?'PLANNING_ISSUES_UNRESOLVED':'PLANNING_CLARIFICATION_UNRESOLVED';next.blockingQuestions??={};next.blockingQuestions[row.id]=pendingIds(next);}
    }
    return next;
}
function clarification(value:Envelope,state:State):KanbanAnalysisObservation|undefined {
    const pending=value.messages.filter(row=>pendingIds(state).includes(row.id)),errors=pending.filter(row=>state.errors?.[row.id]);
    if(errors.length)return {state:'blocked',code:'PLANNING_ERROR_REPORTED',handler:errors.every(row=>row.message.payload?.handler==='self')?'self':'parent',reason:errors.map(row=>row.message.content).join('\n\n').slice(0,8000)};
    return pending.length?{state:'clarification',handler:pending.every(row=>row.message.payload?.handler==='self')?'self':'parent',reason:pending.map(row=>row.message.payload?.reason??row.message.content).join('\n\n').slice(0,8000)}:state.resolved.length?{state:'running'}:undefined;
}
function pendingIds(state:State):string[]{return [...Object.keys(state.questions),...Object.keys(state.errors??{})].filter(id=>!state.resolved.includes(id));}
function terminal(value:Envelope,row:Message):boolean {
    return !!row.origin?.operationId && !!row.origin?.turnId && value.execution?.sessionId===row.origin.sessionId && value.execution.turnId===row.origin.turnId && value.execution.status==='completed';
}
async function acknowledge(remote:Remote,projectId:string,scopeId:string,id:string,status:string):Promise<void> {
    await remote.sessionChannel(projectId,'acknowledge',{scopeId,id,ack:{status,scopeId,messageId:id}});
}

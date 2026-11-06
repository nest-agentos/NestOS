import {channelDigest} from './channel-protocol';
import {failure,type PromptJournal} from './prompt-bundle';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {KanbanAnalysisObservation} from '@nestos/kanban/integration';
interface Origin {sessionId:string;turnId:string;operationId?:string;revision?:number}
interface Message {id:string;message:{type:string;content:string;replyTo?:string;payload?:{ready?:boolean;reason?:string}};origin?:Origin|null}
interface State {seen:Record<string,string>;questions:Record<string,Origin>;resolved:string[];acknowledged?:string[];rejected?:Record<string,string>;blockingQuestions?:Record<string,string[]>;final?:{id:string;digest:string}}
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
        if(state.questions[row.id])await acknowledge(remote,projectId,scopeId,row.id,'waiting-input');
        else if(state.rejected?.[row.id])await remote.sessionChannel(projectId,'acknowledge',{scopeId,id:row.id,ack:{status:'rejected',code:state.rejected[row.id],...(state.blockingQuestions?.[row.id]?{pendingQuestionIds:state.blockingQuestions[row.id]}:{})}});
        else if(row.message.type==='resolved'&&state.resolved.includes(row.message.replyTo??''))await acknowledge(remote,projectId,scopeId,row.id,'validated');
        else continue;
        state=await journal.update<State>(key,old=>({...old!,acknowledged:[...new Set([...old?.acknowledged??[],row.id])]}));
    }
    const reportedError=value.messages.find(row=>row.message.type==='error');
    if(reportedError&&terminal(value,reportedError))return {state:'failed',code:'PLANNING_ERROR_REPORTED'};
    const final=value.messages.filter(row=>row.message.type==='result'&&row.message.payload?.ready===true&&!state.rejected?.[row.id]);
    if(final.length>1)throw failure('CHANNEL_RESULT_INVALID');
    if(final.length){const row=final[0];
        if(Object.keys(state.questions).some(id=>!state.resolved.includes(id)))return clarification(value,state);
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
        if(row.message.type==='result'&&typeof row.message.payload?.ready!=='boolean')throw failure('AUTOMATION_ANALYSIS_INVALID');
        if(row.message.type==='resolved'&&!next.rejected?.[row.id]){
            const question=next.questions[row.message.replyTo??''];
            if(!question||!row.origin||question.sessionId!==row.origin.sessionId||question.turnId===row.origin.turnId
                ||!row.origin.turnId||!row.origin.operationId){next.rejected??={};next.rejected[row.id]='PLANNING_REPLY_UNVERIFIED';continue;}
            if(!next.resolved.includes(row.message.replyTo!))next.resolved.push(row.message.replyTo!);
        }
        if(row.message.type==='result'&&row.message.payload?.ready===true && Object.keys(next.questions).some(id=>!next.resolved.includes(id))){next.rejected??={};next.rejected[row.id]='PLANNING_CLARIFICATION_UNRESOLVED';next.blockingQuestions??={};next.blockingQuestions[row.id]=Object.keys(next.questions).filter(id=>!next.resolved.includes(id));}
    }
    return next;
}
function clarification(value:Envelope,state:State):KanbanAnalysisObservation|undefined {
    const pending=value.messages.filter(row=>state.questions[row.id]&&!state.resolved.includes(row.id));
    return pending.length?{state:'clarification',reason:pending.map(row=>row.message.payload?.reason??row.message.content).join('\n\n').slice(0,8000)}:undefined;
}
function terminal(value:Envelope,row:Message):boolean {
    return !!row.origin?.operationId && !!row.origin?.turnId && value.execution?.sessionId===row.origin.sessionId && value.execution.turnId===row.origin.turnId && value.execution.status==='completed';
}
async function acknowledge(remote:Remote,projectId:string,scopeId:string,id:string,status:string):Promise<void> {
    await remote.sessionChannel(projectId,'acknowledge',{scopeId,id,ack:{status,scopeId,messageId:id}});
}

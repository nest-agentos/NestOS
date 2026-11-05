import {vi} from 'vitest';
import {channelDigest} from '../../src/run/channel-protocol';
export function memoryChannels() {
    const scopes=new Map<string,{cwd?:string;messages:Array<{id:string;message:Record<string,unknown>}>;requests:Array<Record<string,unknown>>;acks:Map<string,unknown>}>();
    const ensure=(id:string)=>{let scope=scopes.get(id);if(!scope){scope={messages:[],requests:[],acks:new Map()};scopes.set(id,scope);}return scope;};
    const channel=vi.fn(async(_project:string,operation:string,input:Record<string,unknown>)=>{
        const id=String(input.scopeId),scope=ensure(id);
        if(operation==='open'){scope.cwd=String(input.cwd);return {scopeId:id,accepted:true};}
        if(operation==='current')return {scopeId:[...scopes].reverse().find(([,value])=>value.cwd===input.cwd)?.[0]??'original',execution:{sessionId:'native-original'}};
        if(operation==='messages')return {messages:structuredClone(scope.messages)};
        if(operation==='requests')return {requests:structuredClone(scope.requests)};
        if(operation==='respond'){const row=scope.requests.find(row=>(row.request as {id:string}).id===input.id)!;row.response={id:input.id,scopeId:id,requestDigest:input.requestDigest,status:input.status,payload:input.payload,error:input.error};return row.response;}
        if(operation==='acknowledge'){scope.acks.set(String(input.id),input.ack);return {acknowledged:true};}
        throw new Error('Unexpected channel operation '+operation);
    });
    return {channel,ensure,report(scope:string,id:string,message:Record<string,unknown>){ensure(scope).messages.push({id,message:structuredClone(message)});},request(scope:string,id:string,method:string,params:Record<string,unknown>){const request={id,scopeId:scope,method,params};ensure(scope).requests.push({request,requestDigest:channelDigest(request),response:null});}};
}

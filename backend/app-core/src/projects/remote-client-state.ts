import {FSError} from '@nestos/vfs-core';
import {sha256HexSync,randomUUID} from '@nestos/common';
import type {ProjectClient,RemoteProject} from '@nestos/cells-driver';
import {mapConcurrent} from '../utils/map-concurrent';
export interface ClientStatePort {queueSession?(sessionId:string,input:import('@nestos/cells-driver').HarnessNodeQueueCommand):Promise<import('@nestos/cells-driver').HarnessInstructionQueue>;registerSession?(sessionId:string):Promise<boolean>;recoverSession?(input:{sessionId:string;operationId:string;instructionId:string;expectedRevision:number}):Promise<void>;read(key:string):Promise<string|null>;compare(key:string,before:string|null,after:string|null,operationId?:string):Promise<boolean>}
interface Head {schema:1;text?:string;sha256?:string;parts?:number;generation?:string}
/** Opaque records live privately on the Cells node, outside project files and NestOS storage. */
export function remoteClientState(client:ProjectClient,project:RemoteProject,namespace:string,checkAccess:()=>void,profileId?:string,writable=true):ClientStatePort {
    return new RemoteClientRecords(client,project,sha256HexSync(namespace),checkAccess,profileId,writable);
}
class RemoteClientRecords implements ClientStatePort {
    constructor(private client:ProjectClient,private project:RemoteProject,private prefix:string,private checkAccess:()=>void,private profileId?:string,private writable=true){}
    async queueSession(sessionId:string,input:import('@nestos/cells-driver').HarnessNodeQueueCommand){
        this.checkAccess();if(!this.profileId || !this.client.queueSession)throw new FSError('ECAPABILITY','Cells queue ownership unavailable');
        return this.client.queueSession(this.project,{...input,sessionId,namespace:this.prefix,profileId:this.profileId,operationId:randomUUID()});
    }
    private registered=new Set<string>();
    async registerSession(sessionId:string):Promise<boolean>{
        this.checkAccess();if(!this.writable || this.registered.has(sessionId))return false;
        if(this.profileId && await this.client.registerSession?.(this.project,{namespace:this.prefix,profileId:this.profileId,sessionId})){this.registered.add(sessionId);return true;}return false;
    }
    async recoverSession(input:{sessionId:string;operationId:string;instructionId:string;expectedRevision:number}):Promise<void>{
        this.checkAccess();if(!this.profileId || !this.client.recoverSession)throw new FSError('ECAPABILITY','Cells recovery unavailable');
        await this.client.recoverSession(this.project,{...input,namespace:this.prefix,profileId:this.profileId,action:'recover'});
    }
    private async call(key:string,action:'read'|'compare',expected?:string|null,value?:string|null,requestId=randomUUID()){
        this.checkAccess();if(!this.client.clientState)throw new FSError('ECAPABILITY','Remote harness state is unavailable');
        return this.client.clientState(this.project,{key:this.prefix+'/'+key,action,expected,value,requestId});
    }
    private async rawRead(key:string){return (await this.call(key,'read')).value??null;}
    private async load(key:string):Promise<{raw:string|null;value:string|null}>{
        for(let attempt=0;attempt<3;attempt++){
            const raw=await this.rawRead(key);if(raw===null)return {raw,value:null};
            const head=JSON.parse(raw) as Head;
            if(head.schema===1&&typeof head.text==='string')return {raw,value:head.text};
            if(head.schema!==1||typeof head.sha256!=='string'||typeof head.generation!=='string'||!/^[a-f0-9]{64}$/.test(head.sha256)||!Number.isInteger(head.parts)||head.parts!<1||head.parts!>258)throw new FSError('EIO','Invalid remote state manifest');
            const chunks=await mapConcurrent(Array.from({length:head.parts!},(_,i)=>i),4,i=>this.rawRead(key+'/'+head.generation+'/'+i));
            if(await this.rawRead(key)!==raw)continue;
            if(chunks.some(value=>value===null)||sha256HexSync(chunks.join(''))!==head.sha256)throw new FSError('EIO','Remote state integrity mismatch');
            return {raw,value:chunks.join('')};
        }throw new FSError('ECONFLICT','Remote state changed during read');
    }
    async read(key:string){return (await this.load(key)).value;}
    async compare(key:string,before:string|null,after:string|null,operationId?:string):Promise<boolean>{
        const current=await this.load(key);if(current.value!==before)return false;if(after===before)return true;
        const next=after===null?null:await this.prepare(key,after);
        const applied=(await this.call(key,'compare',current.raw,next,operationId)).applied===true;
        if(applied&&current.raw)await this.cleanup(key,JSON.parse(current.raw) as Head);return applied;
    }
    private async prepare(key:string,value:string):Promise<string>{
        if(value.length>32*1024*1024)throw new FSError('EFBIG','Remote client state too large');
        if(value.length<=131072)return JSON.stringify({schema:1,text:value});
        const generation=randomUUID(),parts=splitState(value);
        await mapConcurrent(parts.map((part,i)=>({part,i})),4,async({part,i})=>{
            if(!(await this.call(key+'/'+generation+'/'+i,'compare',null,part)).applied)throw new FSError('ECONFLICT','Remote state chunk changed');
        });return JSON.stringify({schema:1,sha256:sha256HexSync(value),generation,parts:parts.length});
    }
    private async cleanup(key:string,old:Head){
        if(!old.generation||!old.parts)return;
        await mapConcurrent(Array.from({length:old.parts},(_,i)=>i),4,async i=>{
            const k=key+'/'+old.generation+'/'+i;
            try{const value=await this.rawRead(k);if(value!==null)await this.call(k,'compare',value,null);}
            catch{console.warn('[Harness] Remote state cleanup deferred',{operation:'harness.client-state',stage:'cleanup',code:'CLIENT_STATE_CLEANUP_PENDING'});}
        });
    }
}
function splitState(text:string):string[]{
    const parts:string[]=[];let offset=0;
    while(offset<text.length){let end=Math.min(text.length,offset+131072);const last=text.charCodeAt(end-1);
        if(end<text.length&&last>=0xD800&&last<=0xDBFF)end--;
        parts.push(text.slice(offset,end));offset=end;
    }return parts;
}

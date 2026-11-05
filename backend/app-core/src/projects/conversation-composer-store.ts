import {FSError,type IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger,randomUUID,arrayBufferToBase64,base64ToArrayBuffer} from '@nestos/common';
import type {ProjectConversationPort,ConversationComposerDraft} from '@nestos/app-contracts/services';
import type {ClientStatePort} from './remote-client-state';
const log=createModuleLogger('remote-composer');
const empty=():ConversationComposerDraft=>({revision:'0',data:'',acceptedOperationIds:[]});
interface Legacy {fs:IFileSystem;projectId:string;owner:string}
/** Remote UI state and assets are stored only on the authenticated harness node. */
export class ConversationComposerStore {
    constructor(private readonly state:ClientStatePort,private readonly writable:boolean,private readonly checkAccess:()=>void,private readonly legacy?:Legacy){}
    async readComposerDraft():Promise<ConversationComposerDraft>{
        this.checkAccess();let raw=await this.state.read('composer');
        if(this.legacy){
            const {fs,projectId,owner}=this.legacy,path=`/var/lib/projects/${projectId}/conversation-input.seq`;
            const old=await fs.driver.exists(path)?await fs.meta.seq!.getEntry(path,owner):null;
            if(old){if(raw===null){await this.state.compare('composer',null,old);raw=await this.state.read('composer');}
                if(raw!==old){const previous=await this.state.read('legacy-composer');if(previous===null)await this.state.compare('legacy-composer',null,old);
                    if(await this.state.read('legacy-composer')!==old)throw new FSError('ECONFLICT','Remote composer migration is unconfirmed');}
                // Assets remain readable during migration; local input is removed only after remote confirmation.
                await fs.meta.seq!.transaction!(tx=>tx.compareAndSet(path,owner,{expected:old,value:null}));
            }
        }
        return raw?JSON.parse(raw):empty();
    }
    async saveComposerDraft(data:string,expectedRevision:string,operationId:string):Promise<ConversationComposerDraft>{
        const started=Date.now();
        try{return await this.persistDraft(data,expectedRevision,operationId);}
        catch(error){const code=(error as {code?:string}).code??'REMOTE_COMPOSER_SAVE_UNKNOWN';
            log.warn('Remote composer save',{operation:'harness.composer.save',operationId,stage:'remote-persist',result:'failure',code,durationMs:Date.now()-started});throw error;}
    }
    private async persistDraft(data:string,expectedRevision:string,operationId:string):Promise<ConversationComposerDraft>{
        this.writeAccess();
        if(typeof data!=='string'||new TextEncoder().encode(data).length>1024*1024||typeof expectedRevision!=='string'||!validId(operationId))throw new FSError('EINVAL','Invalid composer update');
        const before=await this.state.read('composer'),current:ConversationComposerDraft=before?JSON.parse(before):empty();
        if(current.acceptedOperationIds.includes(operationId))return current;
        if(current.revision!==expectedRevision)throw new FSError('ECONFLICT','Composer changed in another view');
        const next={data,revision:randomUUID(),acceptedOperationIds:[...current.acceptedOperationIds,operationId].slice(-64)};
        if(!await this.state.compare('composer',before,JSON.stringify(next),operationId))throw new FSError('ECONFLICT','Composer changed in another view');
        return next;
    }
    async putComposerAsset(content:ArrayBuffer):Promise<string>{
        this.writeAccess();if(!(content instanceof ArrayBuffer)||content.byteLength>20*1024*1024)throw new FSError('EFBIG','Composer asset too large');
        const id=randomUUID();await this.state.compare('asset/'+id,null,arrayBufferToBase64(content));return id;
    }
    async readComposerAsset(id:string):Promise<ArrayBuffer>{
        this.checkAccess();if(!validId(id))throw new FSError('ENOENT','Composer asset unavailable');
        let raw=await this.state.read('asset/'+id);
        if(raw===null&&this.legacy){const {fs,projectId,owner}=this.legacy,path=`/var/lib/projects/${projectId}/conversation-input.seq`;
            if(await fs.driver.exists(path)&&await fs.meta.seq!.getEntry(path,'asset/'+id)===owner){
                const file=`/var/lib/projects/${projectId}/conversation-assets/${id}`;
                raw=arrayBufferToBase64(await fs.driver.readContent(file,{encoding:'binary'}));
                await this.state.compare('asset/'+id,null,raw);
                if(await this.state.read('asset/'+id)!==raw)throw new FSError('ECONFLICT','Remote asset migration is unconfirmed');
                await fs.driver.delete([file]);
            }
        }
        if(raw===null)throw new FSError('ENOENT','Composer asset unavailable');return base64ToArrayBuffer(raw);
    }
    private writeAccess(){this.checkAccess();if(!this.writable)throw new FSError('EACCES','Composer is read only');}
}
function validId(id:unknown):id is string{return typeof id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(id);}
export function withConversationComposer(source:ProjectConversationPort,composer:ConversationComposerStore,release:()=>Promise<void>=async()=>{}):ProjectConversationPort{
    let closed=false;
    return new Proxy(source,{get:(target,key)=>{
        if(key==='close')return async()=>{closed=true;try{await source.close();}finally{await release();}};
        if(['readComposerDraft','saveComposerDraft','putComposerAsset','readComposerAsset'].includes(String(key)))
            return (...args:unknown[])=>closed?Promise.reject(new FSError('EIO','Conversation view closed')):Reflect.get(composer,key,composer).apply(composer,args);
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
}

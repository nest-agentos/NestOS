import {createModuleLogger,randomUUID} from '@nestos/common';
import type {GitJournal} from './contracts';
import {requireValue} from './errors';
const log=createModuleLogger('git-delivery');
export interface GitCleanupReceipt {operationId:string;boardId:string;itemId:string;version:string;phase:'prepared'|'removing'|'cleaned';archive?:string;owner?:string}
export interface GitCleanupRequest {operationId:string;itemId:string;resourceId:string;version:string}
export interface GitCleanupView {version:string;canCleanup:boolean;reasons:string[]}
export interface GitRemovalBoundary {retainArchive(path:string):Promise<void>;beginRemoval():Promise<void>}
export interface GitCleanupPorts<R extends {id:string},V extends GitCleanupView> {
    journal:GitJournal;authorize():Promise<void>;resource():Promise<R>;inspect(resource:R):Promise<V>;
    remove(resource:R,boundary:GitRemovalBoundary):Promise<void>;completed(resource:R):Promise<void>;
}
/** Resource intent only: execution scheduling/cancellation/recovery remain with the caller's execution capability. */
export async function cleanupGitResource<R extends {id:string},V extends GitCleanupView>(ports:GitCleanupPorts<R,V>,boardId:string,request:GitCleanupRequest):Promise<V> {
    const owner=randomUUID(),started=Date.now(),key='worktree-cleanup:'+request.resourceId;let claimed=false,stage='authorize';
    try {
        requireValue(/^[\w-]{1,128}$/.test(request.operationId)&&/^[a-f0-9]{64}$/.test(request.version),'INVALID_WORK_RESOURCE_CLEANUP');
        await ports.authorize();const resource=await ports.resource();requireValue(resource.id===request.resourceId,'WORKTREE_SCOPE_INVALID');const old=await ports.journal.get<GitCleanupReceipt>(key);
        if(old){requireValue(old.operationId===request.operationId&&old.version===request.version&&old.boardId===boardId&&old.itemId===request.itemId,'WORKTREE_CLEANUP_CONFLICT');
            requireValue(old.phase==='cleaned','WORKTREE_CLEANUP_UNCONFIRMED');await ports.completed(resource);return ports.inspect(resource);}
        stage='validate';const current=await ports.inspect(resource);requireValue(current.canCleanup,current.reasons[0]??'WORKTREE_CLEANUP_BLOCKED');requireValue(current.version===request.version,'WORKTREE_STATE_CHANGED');
        const saved=await ports.journal.update<GitCleanupReceipt>(key,value=>value??{operationId:request.operationId,boardId,itemId:request.itemId,version:request.version,phase:'prepared',owner});
        requireValue(saved.owner===owner,'WORKTREE_CLEANUP_UNCONFIRMED');claimed=true;stage='archive-and-remove';
        await ports.remove(resource,{retainArchive:async archive=>{await ports.journal.update<GitCleanupReceipt>(key,value=>({...value!,archive}));},
            beginRemoval:async()=>{await ports.journal.update<GitCleanupReceipt>(key,value=>({...value!,phase:'removing'}));}});
        await ports.journal.update<GitCleanupReceipt>(key,value=>({...value!,phase:'cleaned'}));await ports.completed(resource);return ports.inspect(resource);
    }catch(error){if(claimed)await releasePrepared(ports.journal,key,owner,request.operationId);log.warn('Cleanup failed',{operation:'git.cleanup',operationId:request.operationId,stage,result:'failure',code:safeCode(error),durationMs:Date.now()-started});throw error;}
    finally{log.debug('Cleanup finished',{operation:'git.cleanup',operationId:request.operationId,stage,durationMs:Date.now()-started});}
}
async function releasePrepared(journal:GitJournal,key:string,owner:string,operationId:string):Promise<void> {
    await journal.update<GitCleanupReceipt|null>(key,value=>value?.owner===owner&&value.phase==='prepared'?null:value??null).catch(error=>{
        log.warn('Cleanup claim retained',{operation:'git.cleanup',operationId,stage:'claim-release',result:'failure',code:safeCode(error),durationMs:0});
    });
}
function safeCode(error:unknown):string {const value=error as {code?:unknown;remoteCode?:unknown},code=value?.remoteCode??value?.code;return code==='EBUSY'?'WORK_RESOURCE_NODE_BUSY':typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'WORK_RESOURCE_CHECK_FAILED';}

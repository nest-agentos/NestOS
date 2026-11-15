import type {DecisionConversation,DecisionConversationOptions} from './decision-conversation-ports';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';
import {readPrompt} from '../run/prompt-bundle';
type Channel={scopeId?:string;execution?:{sessionId?:string}};
/** Use the durable ownership stamp on ordinary reads; probe the directory again only after a missing-path receipt. */
export async function retainedManagementChannel(options:DecisionConversationOptions,value:DecisionConversation):Promise<{channel:Channel;repaired:boolean}> {
    let repaired=await retainManagementDirectory(options,value);
    const read=()=>options.remote.sessionChannel(value.binding.projectId,'current',{cwd:value.binding.directory}) as Promise<Channel>;
    try{return {channel:await read(),repaired};}
    catch(error){if(safeCode(error,'UNKNOWN')!=='ENOENT')throw error;repaired=await retainManagementDirectory(options,value,true)||repaired;return {channel:await read(),repaired};}
}
/** Repair only a proven legacy cleanup. This never creates a Session or restores a Git worktree. */
export async function retainManagementDirectory(options:DecisionConversationOptions,value:DecisionConversation,verify=false):Promise<boolean> {
    if(!value.binding.retainedPlanning||value.clearedAt!==undefined)return false;
    const key='management-session-directory:'+value.id,cached=await options.journal.get<{projectId:string;directory:string;sessionId:string}>(key);
    const identity={projectId:value.binding.projectId,directory:value.binding.directory,sessionId:value.sessionId};
    if(!verify&&cached&&JSON.stringify(cached)===JSON.stringify(identity))return false;
    const cleanup=await options.journal.get<{phase:string}>('worktree-cleanup:'+value.id);if(cleanup?.phase!=='cleaned')return false;
    requireValue(/^[\w-]{1,128}$/.test(value.id)&&value.sessionId&&value.resourceId&&value.binding.directory==='/workspace/_nestos/worktrees/'+value.id,'MANAGEMENT_DIRECTORY_BINDING_CHANGED');
    const started=Date.now(),folder=await options.projects.get(value.binding.projectId),view=await options.projects.openWorkspace(folder.path);
    try{
        const marker=value.binding.directory+'/.nestos-management-context',exists=await view.fs.driver.exists(value.binding.directory);
        if(exists){const owner=JSON.parse(await readPrompt(view.fs,marker));requireValue(owner.conversationId===value.id&&owner.sessionId===value.sessionId,'MANAGEMENT_DIRECTORY_BINDING_CHANGED');}
        else await view.fs.driver.createFile({parentPath:value.binding.directory,name:'.nestos-management-context',recursive:true,content:JSON.stringify({schema:1,conversationId:value.id,sessionId:value.sessionId,channelId:value.binding.channelId})});
        await options.journal.update(key,()=>identity);
        options.log({operationId:value.id,boardId:value.boardId,stage:'coordination.directory.retain',result:'success',durationMs:Date.now()-started});return !exists;
    }catch(error){options.log({operationId:value.id,boardId:value.boardId,stage:'coordination.directory.retain',result:'failure',code:safeCode(error,'MANAGEMENT_DIRECTORY_RETAIN_FAILED'),durationMs:Date.now()-started});throw error;}finally{await view.dispose();}
}

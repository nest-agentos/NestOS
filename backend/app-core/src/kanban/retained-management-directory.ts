import type {DecisionConversation,DecisionConversationOptions} from './decision-conversation-ports';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';
/** Repair only a known retained Session anchor after a proven legacy Git cleanup; never create a Session or worktree. */
export async function retainManagementDirectory(options:DecisionConversationOptions,value:DecisionConversation):Promise<boolean> {
    if(!value.binding.retainedPlanning||value.clearedAt!==undefined)return false;
    const cleanup=await options.journal.get<{phase:string}>('worktree-cleanup:'+value.id);if(cleanup?.phase!=='cleaned')return false;
    requireValue(/^[\w-]{1,128}$/.test(value.id)&&value.sessionId&&value.resourceId&&value.binding.directory==='/workspace/_nestos/worktrees/'+value.id,'MANAGEMENT_DIRECTORY_BINDING_CHANGED');
    const started=Date.now(),folder=await options.projects.get(value.binding.projectId),view=await options.projects.openWorkspace(folder.path);
    try{
        if(await view.fs.driver.exists(value.binding.directory))return false;
        await view.fs.driver.createFile({parentPath:value.binding.directory,name:'.nestos-management-context',recursive:true,
            content:JSON.stringify({schema:1,conversationId:value.id,sessionId:value.sessionId,channelId:value.binding.channelId})});
        await options.journal.update('management-session-directory:'+value.id,old=>old??{projectId:value.binding.projectId,directory:value.binding.directory,sessionId:value.sessionId});
        options.log({operationId:value.id,boardId:value.boardId,stage:'coordination.directory.retain',result:'success',durationMs:Date.now()-started});return true;
    }catch(error){options.log({operationId:value.id,boardId:value.boardId,stage:'coordination.directory.retain',result:'failure',code:safeCode(error,'MANAGEMENT_DIRECTORY_RETAIN_FAILED'),durationMs:Date.now()-started});throw error;}finally{await view.dispose();}
}

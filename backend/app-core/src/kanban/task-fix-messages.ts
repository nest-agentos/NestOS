import type {Options,SavedFix} from './task-fix-contracts';
import {inWorkspace} from './task-fix-files';
import {consumeWorkspaceMessages} from '../run/workspace-messages';
/** Clarification notifications belong to the fix Session, never the original execution's blocking state. */
export async function observeFixMessages(options:Options,fix:SavedFix):Promise<void> {
    await inWorkspace(options,fix,async(fs,directory)=>{
        const root=directory.slice(0,-('/fix/'+fix.id).length);if(!await fs.driver.exists(root+'/inbox'))return;
        const scope={runId:fix.item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??fix.id,itemId:fix.itemId,attemptId:fix.id};
        await consumeWorkspaceMessages(fs,root,scope,options.journal,async message=>{
            await options.events.journal.transaction(async tx=>{
                const key='fix-message:'+fix.id+':'+message.id;if(await tx.getState(key))return;
                await tx.append(key,{type:'kanban.fix.'+message.type,operationId:fix.id,
                    resourceId:'kanban:'+JSON.stringify(['personal:user-store',fix.boardId,fix.itemId]),
                    ...(['clarification','error'].includes(message.type)?{notification:message.type==='error'?'error' as const:'info' as const}:{})},Date.now());
                await tx.setState(key,'delivered');
            });
        });
    });
}

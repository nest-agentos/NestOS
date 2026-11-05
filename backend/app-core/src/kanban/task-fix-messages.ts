import type {Options} from './task-fix-contracts';
import type {SavedFix} from '@nestos/kanban/integration';
import {fixMessages} from './task-fix-channel';
import {consumeChannelMessages} from '../run/channel-messages';
/** Clarification notifications belong to the fix Session, never the original execution's blocking state. */
export async function observeFixMessages(options:Options,fix:SavedFix):Promise<void> {
        const scope={runId:fix.item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id??fix.id,itemId:fix.itemId,attemptId:fix.id};
        await consumeChannelMessages({messages:await fixMessages(options,fix)},scope,options.journal,async message=>{
            await options.events.journal.transaction(async tx=>{
                const key='fix-message:'+fix.id+':'+message.id;if(await tx.getState(key))return;
                await tx.append(key,{type:'kanban.fix.'+message.type,operationId:fix.id,
                    resourceId:'kanban:'+JSON.stringify(['personal:user-store',fix.boardId,fix.itemId]),
                    ...(['clarification','error'].includes(message.type)?{notification:message.type==='error'?'error' as const:'info' as const}:{})},Date.now());
                await tx.setState(key,'delivered');
            });
        },async message=>{await options.automation.sessionChannel!(fix.resourceId,'acknowledge',{scopeId:fix.id,id:message.id,ack:{status:'delivered'}});});
}

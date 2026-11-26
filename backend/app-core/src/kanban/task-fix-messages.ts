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
        },(message,rejection)=>acknowledgeFixNotice(options,fix,message.id,rejection));
}

async function acknowledgeFixNotice(options:Options,fix:SavedFix,id:string,rejection?:string):Promise<void> {
    const started=Date.now();
    try {
        await options.automation.sessionChannel!(fix.resourceId,'acknowledge',{
            scopeId:fix.id,id,ack:rejection?{status:'rejected',code:rejection}:{status:'delivered'}});
    } catch(error) {
        const code=error as {code?:string;remoteCode?:string};
        if(rejection || (code?.remoteCode??code?.code)!=='CHANNEL_ACK_CHANGED')throw error;
        // Another observer already acknowledged the same immutable publication.
        options.log({operationId:fix.id,boardId:fix.boardId,stage:'task.repair.notice.acknowledge',
            result:'success',code:'CHANNEL_ACK_CHANGED',durationMs:Date.now()-started});
    }
}

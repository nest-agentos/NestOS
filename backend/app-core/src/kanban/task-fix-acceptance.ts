import type {Options} from './task-fix-contracts';
import type {SavedFix} from '@nestos/kanban/integration';
import {KanbanCollaboration} from '@nestos/kanban/integration';
import {requireValue} from './validation';
import {safeCode} from '@nestos/kanban/integration';

export async function acceptSnapshot(options:Options,fix:SavedFix):Promise<void> {
    const started=Date.now();
    try {
    for(const child of fix.snapshot?.definition.children??[]) {
        if(child.estimate)await options.journal.update('decomposition-estimate:'+JSON.stringify([fix.boardId,child.id]),old=>old??child.estimate);
        await options.journal.update('decomposition-status:'+JSON.stringify([fix.boardId,child.id]),old=>old??{itemId:child.id,state:'ready',dependencies:child.dependsOn});
    }
    await new KanbanCollaboration(options.service,options.journal).acceptFix(fix.id,{kind:'fix',inheritSystems:['nestos-remote-project','nestos-decision-run']},async saved=>{
        await notify(options,saved);
        requireValue(options.automation.sessionChannel,'SESSION_CHANNEL_REQUIRED');
        const operationId=saved.snapshot!.operationId;
        await options.automation.sessionChannel(saved.resourceId,'acknowledge',{scopeId:saved.id,id:saved.snapshot!.proposalId,
            ack:{operationId,itemId:saved.snapshot!.definition.children?saved.itemId:operationId,status:'accepted',content:'Definition accepted; development awaits dependencies and start deadline'}});
    });
    options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'success',durationMs:Date.now()-started});
    }catch(error){options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'failure',code:safeCode(error,'FIX_ACCEPT_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function notify(options:Options,fix:SavedFix):Promise<void> {
    const snapshot=fix.snapshot!,createdItemId=snapshot.definition.children?fix.itemId:snapshot.operationId;
    await options.events.journal.transaction(async tx=>{
        const key='fix-accepted:'+fix.id;if(await tx.getState(key))return;
        await tx.append(key,{type:'kanban.fix.accepted',operationId:snapshot.operationId,resourceId:'kanban:'+JSON.stringify(['personal:user-store',fix.boardId,createdItemId]),notification:'info'},Date.now());
        await tx.setState(key,'delivered');
    });
}

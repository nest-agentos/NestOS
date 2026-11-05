import type {Options,SavedFix} from './task-fix-contracts';
import {journalCommand} from './journal-command';
import {requireValue} from './validation';
import {safeCode} from './automation-analysis';

export async function acceptSnapshot(options:Options,fix:SavedFix):Promise<void> {
    const started=Date.now();
    try {
    const board=await options.service.read(fix.boardId);
    requireValue(!board.workTypes?.length||board.workTypes.some(type=>type.id==='fix'&&type.executable),'FIX_WORK_TYPE_REQUIRED');
    await publishDefinition(options,fix);await createTask(options,fix);await notify(options,fix);
    const operationId=fix.snapshot!.operationId;
    requireValue(options.automation.sessionChannel,'SESSION_CHANNEL_REQUIRED');
    await options.automation.sessionChannel(fix.projectId,'acknowledge',{scopeId:fix.id,id:fix.snapshot!.proposalId,ack:{operationId,itemId:operationId,status:'accepted',content:'Definition accepted; development awaits dependencies and start deadline'}});
    await options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,accepted:true,state:'accepted',createdItemId:operationId}));
    options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'success',durationMs:Date.now()-started});
    }catch(error){options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'failure',code:safeCode(error,'FIX_ACCEPT_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function publishDefinition(options:Options,fix:SavedFix):Promise<void> {
    const snapshot=fix.snapshot!;
    const envelope={schema:'kanban.fix/1',version:1,operationId:snapshot.operationId,sourceSessionId:fix.sessionId,
        confirmation:{messageId:snapshot.messageId,content:snapshot.content,digest:snapshot.digest},board:{id:fix.boardId},project:{id:fix.projectId},...snapshot.definition};
    const published=await options.journal.update<unknown>('fix-definition:'+fix.id,old=>{
        requireValue(!old||JSON.stringify(old)===JSON.stringify(envelope),'FIX_DEFINITION_CHANGED');
        return old??envelope;
    });
    requireValue(JSON.stringify(published)===JSON.stringify(envelope),'FIX_DEFINITION_CHANGED');
}
async function createTask(options:Options,fix:SavedFix):Promise<void> {
    const snapshot=fix.snapshot!,createdItemId=snapshot.operationId;
    await journalCommand(options.journal,options.service,fix.boardId,'fix-create:'+fix.id,{type:'create-item',item:{id:createdItemId,
        title:snapshot.definition.title,responsibility:snapshot.definition.responsibility,acceptance:snapshot.definition.acceptance,
        externalRefs:fix.item.externalRefs?.filter(ref=>['nestos-remote-project','nestos-decision-run'].includes(ref.system))},
        planning:{kind:'fix',priority:fix.item.planning?.priority??2,dependencies:snapshot.definition.dependencies,references:[]}});
}
async function notify(options:Options,fix:SavedFix):Promise<void> {
    const snapshot=fix.snapshot!,createdItemId=snapshot.operationId;
    await options.events.journal.transaction(async tx=>{
        const key='fix-accepted:'+fix.id;if(await tx.getState(key))return;
        await tx.append(key,{type:'kanban.fix.accepted',operationId:snapshot.operationId,resourceId:'kanban:'+JSON.stringify(['personal:user-store',fix.boardId,createdItemId]),notification:'info'},Date.now());
        await tx.setState(key,'delivered');
    });
}

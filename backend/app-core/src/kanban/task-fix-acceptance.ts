import type {Options,SavedFix} from './task-fix-contracts';
import {inWorkspace} from './task-fix-files';
import {parseSessionFile} from '../run/session-file-result';
import {publishFile,readPrompt} from '../run/prompt-bundle';
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
    await inWorkspace(options,fix,(fs,directory)=>publishFile(fs,directory,'accepted.yaml',JSON.stringify({schema:'kanban.fix-reply/1',operationId,itemId:operationId,content:'Definition accepted; development awaits dependencies and start deadline'})));
    await options.journal.update<SavedFix>('fix:'+fix.id,old=>({...old!,accepted:true,state:'accepted',createdItemId:operationId}));
    options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'success',durationMs:Date.now()-started});
    }catch(error){options.log({operationId:fix.id,boardId:fix.boardId,stage:'fix.accept',result:'failure',code:safeCode(error,'FIX_ACCEPT_FAILED'),durationMs:Date.now()-started});throw error;}
}
async function publishDefinition(options:Options,fix:SavedFix):Promise<void> {
    const snapshot=fix.snapshot!;
    const envelope={schema:'kanban.fix/1',version:1,operationId:snapshot.operationId,sourceSessionId:fix.sessionId,
        confirmation:{messageId:snapshot.messageId,content:snapshot.content,digest:snapshot.digest},board:{id:fix.boardId},project:{id:fix.projectId},...snapshot.definition};
    await inWorkspace(options,fix,async(fs,directory)=>{
        await publishFile(fs,directory,'confirmation.yaml',JSON.stringify({schema:'kanban.fix-confirmation/1',...snapshot}));
        await publishFile(fs,directory,'kanban.yaml',JSON.stringify(envelope));
        const published=parseSessionFile(await readPrompt(fs,directory+'/kanban.yaml'));
        requireValue(JSON.stringify(published)===JSON.stringify(envelope),'FIX_FILE_SCOPE_MISMATCH');
    });
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

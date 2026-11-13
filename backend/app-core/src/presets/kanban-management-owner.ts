import {createModuleLogger} from '@nestos/common';
import {resolveManagementTaskOwner,safeCode} from '@nestos/kanban/integration';
import type {KanbanBoard,KanbanItem,KanbanService} from '@nestos/kanban/contracts';
const log=createModuleLogger('kanban-owner');
/** Board visibility never changes the stable identity used to resolve ownership. */
export async function managementOwner(service:Pick<KanbanService,'item'>,board:KanbanBoard,item:KanbanItem):Promise<KanbanItem|undefined> {
    const started=Date.now();let parentArchived=false;
    try{return await resolveManagementTaskOwner(board,item,async id=>{
        try{const detail=await service.item(board.id,id);parentArchived||=!!detail.archive;return detail.item;}
        catch(error){if((error as {code?:string}).code==='ITEM_NOT_FOUND')return;throw error;}
    });}catch(error){const detail=error as {parentId?:string;reason?:string};
        const reason=['parent-missing','parent-deleted','cycle','identity-mismatch'].includes(detail.reason??'')?detail.reason:'read-failed';
        log.warn('Task ownership resolution failed',{operation:'kanban.owner.resolve',operationId:item.id,boardId:board.id,itemId:item.id,parentId:reason==='read-failed'?undefined:detail.parentId,parentArchived,
            stage:'ancestry',result:'failure',code:safeCode(error,'OPERATION_OWNER_READ_FAILED'),reason,durationMs:Date.now()-started});throw error;}
}

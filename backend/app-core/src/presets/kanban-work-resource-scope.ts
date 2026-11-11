import {createModuleLogger,randomUUID} from '@nestos/common';
import type {KanbanItem,KanbanService,KanbanExternalReference} from '@nestos/kanban/contracts';
import {itemsWithinRoots,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
const log=createModuleLogger('kanban-work-resources');

/** Current task ancestry defines the visible family; a copied work-log reference grants no ownership. */
export async function taskResourceFamily(service:KanbanService,boardId:string,item:KanbanItem):Promise<Map<string,KanbanItem>> {
    const family=new Map([[item.id,item]]);if(item.planning?.execution!=='children')return family;
    const board=await service.read(boardId);
    for(const child of itemsWithinRoots(board.items,[item.id],{includeDeleted:true}))family.set(child.id,child);
    return family;
}
export async function ownedResourceReferences(journal:KanbanAutomationJournal,boardId:string,family:Map<string,KanbanItem>,refs:KanbanExternalReference[]):Promise<KanbanExternalReference[]> {
    const started=Date.now(),records=await journal.getMany<DevelopmentWorkspaceRecord>(refs.map(ref=>'development-workspace:'+ref.id));
    const visible=refs.filter((_ref,index)=>{
        const context=records[index]?.context as {board?:{id?:string};task?:{id?:string}}|undefined;
        // Keep an explicitly associated resource whose owner cannot be verified, so it cannot disappear or be cleaned.
        return !context?.board?.id||!context.task?.id||context.board.id===boardId&&family.has(context.task.id);
    });
    if(visible.length!==refs.length)log.debug('work-resource.scope',{operation:'work-resource.list',operationId:randomUUID(),stage:'ownership.filter',result:'success',count:visible.length,excluded:refs.length-visible.length,durationMs:Date.now()-started});
    return visible;
}

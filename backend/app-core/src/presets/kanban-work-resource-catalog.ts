import {createModuleLogger,randomUUID} from '@nestos/common';
import {resolvedWorkResources,workResourceResolutionKey} from './kanban-work-resource-resolution';
import {kanbanTaskType} from '@nestos/kanban/contracts';
import type {KanbanItem,KanbanBoardWorkResourceQuery,KanbanBoardWorkResourcePage,KanbanItemSummary,KanbanWorkResourceTask,KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import type {PreparedWorktree} from '../projects/worktree-preparation';
import {requireValue} from '../kanban/validation';
const log=createModuleLogger('kanban-worktrees');
interface Association {id:string;boardId:string;itemId:string;parentId?:string;projectId:string;createdAt:number}
interface Cleanup {phase:string}
interface Options {journal:KanbanAutomationJournal;service:KanbanService;projectLabel(id:string):Promise<string>}
const key=(board:string,id?:string)=>'work-resource:'+(id===undefined?JSON.stringify([board]).slice(0,-1)+',':JSON.stringify([board,id]));

/** This small derived association is rebuilt from frozen workspace ownership, never treated as cleanup authority. */
export async function registerWorkResource(journal:KanbanAutomationJournal,id:string,record:Pick<DevelopmentWorkspaceRecord,'projectId'|'context'|'worktreeId'>):Promise<void>{
    if(record.worktreeId&&record.worktreeId!==id)return;
    const context=record.context as {board?:{id?:string};task?:KanbanItem}|undefined,item=context?.task,boardId=context?.board?.id;
    if(!boardId||!item?.id)return;
    const association:Association={id,boardId,itemId:item.id,parentId:item.planning?.parentId,projectId:record.projectId,createdAt:item.createdAt??0};
    await journal.update<Association>(key(boardId,id),old=>{requireValue(!old||old.itemId===association.itemId&&old.projectId===association.projectId,'WORK_RESOURCE_OWNER_CHANGED');return old??association;});
}
async function ensureCatalog(journal:KanbanAutomationJournal):Promise<void>{
    if(await journal.get('work-resource-catalog-version')===1)return;
    let scanned=0;const started=Date.now(),operationId=randomUUID(),rows=await journal.find<DevelopmentWorkspaceRecord>('development-workspace:',()=>{requireValue(++scanned<=2000,'WORK_RESOURCE_INDEX_LIMIT');return true;});
    for(const row of rows)await registerWorkResource(journal,row.key.slice('development-workspace:'.length),row.value);
    await journal.update('work-resource-catalog-version',()=>1);
    log.info('work-resource.catalog',{operationId,stage:'association-migration',result:'success',count:rows.length,durationMs:Date.now()-started});
}
export async function boardWorkResources(options:Options,boardId:string,query:KanbanBoardWorkResourceQuery={}):Promise<KanbanBoardWorkResourcePage>{
    const started=Date.now(),operationId=randomUUID();
    try{
        requireValue(query&&typeof query==='object'&&!Array.isArray(query)&&Object.keys(query).every(key=>['limit','cursor','includeCleaned'].includes(key)),'INVALID_WORK_RESOURCE_QUERY');
        const limit=query.limit??30;requireValue(Number.isInteger(limit)&&limit>0&&limit<=100&&(query.includeCleaned===undefined||typeof query.includeCleaned==='boolean'),'INVALID_WORK_RESOURCE_QUERY');
        await options.service.query(boardId,{view:'all',limit:1});await ensureCatalog(options.journal);
        const associations=(await options.journal.find<Association>(key(boardId),row=>row.boardId===boardId)).map(row=>row.value).sort((a,b)=>b.createdAt-a.createdAt||a.id.localeCompare(b.id));
        const [cleanup,trees]=await Promise.all([options.journal.getMany<Cleanup>(associations.map(row=>'worktree-cleanup:'+row.id)),options.journal.getMany<PreparedWorktree>(associations.map(row=>'worktree:'+row.id))]);
        const resolutions=await options.journal.getMany(associations.map(row=>workResourceResolutionKey(boardId,row.itemId,row.id)));
        const visible=associations.filter((_row,index)=>trees[index]&&(query.includeCleaned||cleanup[index]?.phase!=='cleaned'&&!resolutions[index]));
        const start=query.cursor?visible.findIndex(row=>row.id===query.cursor)+1:0;
        requireValue(!query.cursor||start>0,'CURSOR_STALE');
        const page=visible.slice(start,start+limit),items=await resolvedWorkResources(options.journal,boardId,undefined,await catalogRows(options,boardId,page));
        log.debug('work-resource.catalog',{operationId,stage:'associations',result:'success',count:items.length,durationMs:Date.now()-started});
        return {items,total:visible.length,...(start+items.length<visible.length?{nextCursor:items.at(-1)!.id}:{})};
    }catch(error){log.warn('work-resource.catalog',{operationId,stage:'associations',result:'failure',code:(error as {code?:string}).code??'WORK_RESOURCE_CATALOG_FAILED',durationMs:Date.now()-started});throw error;}
}
async function catalogRows(options:Options,boardId:string,rows:Association[]){
    if(!rows.length)return [];
    const ids=[...new Set(rows.flatMap(row=>[row.itemId,...row.parentId?[row.parentId]:[]]))];
    const tasks=await options.service.query(boardId,{view:'all',includeDeleted:true,ids,limit:200});
    const byId=new Map(tasks.items.map(item=>[item.id,item])),projectIds=[...new Set(rows.map(row=>row.projectId))];
    const labels=new Map(await Promise.all(projectIds.map(async id=>[id,await options.projectLabel(id)] as const)));
    const [trees,cleanup]=await Promise.all([options.journal.getMany<PreparedWorktree>(rows.map(row=>'worktree:'+row.id)),options.journal.getMany<Cleanup>(rows.map(row=>'worktree-cleanup:'+row.id))]);
    return rows.map((row,index)=>{const item=byId.get(row.itemId),parentId=item?.planning.parentId??row.parentId,coordinator=parentId?byId.get(parentId):item&&kanbanTaskType(item)==='coordination'?item:undefined;
        return {id:row.id,itemId:row.itemId,kind:'git-worktree',title:trees[index]?.branch??row.id,location:trees[index]?.directory??row.id,archivedAt:trees[index]?.archivedAt,version:'',state:cleanup[index]?.phase==='cleaned'?'cleaned' as const:'associated' as const,reasons:[],properties:[],canCleanup:false,
            project:{id:row.projectId,label:labels.get(row.projectId)??row.projectId},task:taskView(item),coordinationTask:taskView(coordinator)};});
}
function taskView(item:KanbanItemSummary|undefined):KanbanWorkResourceTask|undefined{
    return item?{id:item.id,number:item.number,title:item.title,status:item.status,taskType:kanbanTaskType(item),phase:item.task?.phase,progress:item.progress,archived:item.archivedAt!==undefined,deleted:item.deletedAt!==undefined}:undefined;
}

export async function associatedWorkResourceIds(journal:KanbanAutomationJournal,boardId:string,itemId:string|string[]):Promise<string[]>{
    const owners=new Set(typeof itemId==='string'?[itemId]:itemId);
    return (await journal.find<Association>(key(boardId),row=>row.boardId===boardId&&owners.has(row.itemId))).map(row=>row.value.id);
}

import {SeqKanbanStore,migrateTaskHierarchy} from '@nestos/kanban/storage';
import {createModuleLogger,t} from '@nestos/common';
import type {IFileSystem} from '@nestos/vfs-core';

const log=createModuleLogger('kanban-hierarchy');
async function openStore(fs:IFileSystem,path:string):Promise<SeqKanbanStore> {
    const store=await SeqKanbanStore.open(fs,path);
    await migrateTaskHierarchy(store,{actor:{kind:'service',id:'kanban-hierarchy-migration'},
        ungrouped:{title:t('kanban.ungroupedManagement'),responsibility:t('kanban.ungroupedResponsibility'),acceptance:t('kanban.ungroupedAcceptance')},
        log:event=>event.result==='failure'?log.error('kanban.hierarchy',event):log.info('kanban.hierarchy',event)});
    return store;
}
export function openPersonalKanbanStore(fs: IFileSystem): Promise<SeqKanbanStore> {return openStore(fs, '/var/lib/kanban');}
export function openProjectKanbanStore(fs: IFileSystem): Promise<SeqKanbanStore> {return openStore(fs, '/.nestos/kanban');}

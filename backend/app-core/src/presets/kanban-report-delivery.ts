import {deliverSoftwareReports} from '@nestos/kanban-development';
import type {KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import {managementOwner} from '../kanban/task-owner';
import type {ProjectRemoteMountService,RemoteFileSourceProvider} from '../projects/remote-mounts';
/** Bind project capabilities; report selection, packaging and handoff are plugin policy. */
export async function handoffDevelopmentReports(options:{journal:KanbanAutomationJournal;remote:ProjectRemoteMountService;provider:RemoteFileSourceProvider},service:KanbanService,boardId:string,itemId:string,resourceId:string):Promise<string|undefined> {
    const record=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+resourceId);if(!record)return;
    const board=await service.read(boardId),{item}=await service.item(boardId,itemId),owner=await managementOwner(service,board,item)??item;
    return developmentWorkspace(options.remote,options.provider,record.projectId,process=>deliverSoftwareReports({journal:options.journal,service,process,
        directory:record.directory,resourceId:record.worktreeId??resourceId,owner:{boardId,itemId:owner.id}}));
}

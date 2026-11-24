import {deliverSoftwareReports,inspectSoftwareReports,releaseSoftwareReportPackages} from '@nestos/kanban-development';
import {kanbanTaskType,type KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {GitCleanupReceipt} from '@nestos/git-delivery/cleanup';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
import {developmentWorkspace} from './kanban-development-workspace';
import {managementOwner} from '../kanban/task-owner';
import type {ProjectRemoteMountService,RemoteFileSourceProvider} from '../projects/remote-mounts';
import {requireValue} from '../kanban/validation';
/** Bind project capabilities; report selection, packaging and handoff are plugin policy. */
export async function handoffDevelopmentReports(options:{journal:KanbanAutomationJournal;remote:ProjectRemoteMountService;provider:RemoteFileSourceProvider},service:KanbanService,boardId:string,itemId:string,resourceId:string,existingOnly=false):Promise<string|undefined> {
    const record=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+resourceId);if(!record)return;
    const board=await service.read(boardId),{item}=await service.item(boardId,itemId),owner=await managementOwner(service,board,item)??item;
    return developmentWorkspace(options.remote,options.provider,record.projectId,process=>deliverSoftwareReports({journal:options.journal,service,process,
        directory:record.directory,resourceId:record.worktreeId??resourceId,existingOnly,owner:{boardId,itemId:owner.id}}));
}

export function inspectDevelopmentReports(options:{remote:ProjectRemoteMountService;provider:RemoteFileSourceProvider},record:DevelopmentWorkspaceRecord) {
    return developmentWorkspace(options.remote,options.provider,record.projectId,process=>inspectSoftwareReports(process,record.directory));
}

export function releaseCompletedDevelopmentReports(options:{journal:KanbanAutomationJournal;remote:ProjectRemoteMountService;provider:RemoteFileSourceProvider;service:KanbanService}) {
    return releaseSoftwareReportPackages({journal:options.journal,ready:async receipt=>{
        const cleanup=await options.journal.get<GitCleanupReceipt>('worktree-cleanup:'+receipt.resourceId);
        if(cleanup?.phase!=='cleaned'||cleanup.boardId!==receipt.owner.boardId)return false;
        const {item}=await options.service.item(receipt.owner.boardId,receipt.owner.itemId);
        return item.status==='completed'&&kanbanTaskType(item)==='coordination';
    },withProcess:async(receipt,work)=>{
        const record=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+receipt.resourceId);
        requireValue(record,'WORKTREE_NOT_ASSOCIATED');
        await developmentWorkspace(options.remote,options.provider,record.projectId,work);
    }});
}

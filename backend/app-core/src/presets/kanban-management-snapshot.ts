import {combineGitSnapshots,type GitSnapshot} from '@nestos/git-delivery/snapshots';
import type {KanbanBoard,KanbanItem,KanbanService} from '@nestos/kanban/contracts';
import type {ReviewSnapshot} from '@nestos/kanban-development';
import {requireValue} from '../kanban/validation';
import {managementOwner} from '../kanban/task-owner';
import {type ManagementScope} from './kanban-management-scope-catalog';

export interface ManagementSource {itemId:string;dispatchId:string;snapshot:ReviewSnapshot}
export interface ManagementBatch {
    schema:'nestos.kanban.management-batch/1';scopeId:string;boardId:string;ownerId:string;projectId:string;sources:ManagementSource[];
}
export async function managementBatchSnapshot(scope:ManagementScope,board:KanbanBoard,service:KanbanService,
    snapshot:(item:KanbanItem)=>Promise<ReviewSnapshot>):Promise<ReviewSnapshot> {
    const workflow=await service.workflow(board.id),sources:ManagementSource[]=[];
    for(const contribution of scope.contributors){
        const {item}=await service.item(board.id,contribution.itemId);
        requireValue(!item.deletedAt&&item.status!=='cancelled'&&(await managementOwner(service,board,item))?.id===scope.ownerId,'OPERATION_SCOPE_CHANGED');
        const latest=Object.values(workflow.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        requireValue(latest&&latest.id===contribution.dispatchId&&['succeeded','accepted'].includes(latest.outcome??''),'OPERATION_SOURCES_NOT_READY');
        const evidence=await snapshot(item);
        sources.push({itemId:item.id,dispatchId:latest.id,snapshot:evidence});
    }
    const combined=combineGitSnapshots(sources.map(source=>({identity:[source.itemId,source.dispatchId],snapshot:source.snapshot as GitSnapshot})));
    const batch:ManagementBatch={schema:'nestos.kanban.management-batch/1',scopeId:scope.id,boardId:scope.boardId,ownerId:scope.ownerId,projectId:scope.projectId,sources};
    return {...combined,context:{...combined.context,management:batch}};
}
export function managementBatch(snapshot:ReviewSnapshot):ManagementBatch {
    const batch=(snapshot.context as {management?:ManagementBatch})?.management;
    requireValue(batch?.schema==='nestos.kanban.management-batch/1'&&Array.isArray(batch.sources)&&batch.sources.length>0,'OPERATION_SCOPE_INVALID');
    return batch;
}

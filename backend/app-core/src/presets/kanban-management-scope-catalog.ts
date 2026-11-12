import {managementTaskOwner as managementOwner} from '@nestos/kanban/integration';
import {sha256HexSync} from '@nestos/common';
import type {KanbanBoard,KanbanItem,KanbanService,KanbanDispatch} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import {workProjectId} from '../kanban/task-projects';
import {requireValue} from '../kanban/validation';
import type {ReviewOperationScope} from '@nestos/kanban-development';

export interface ManagementContribution {itemId:string;title:string;dispatchId?:string;worktreeId?:string}
export interface ManagementScope extends ReviewOperationScope {
    schema:1;boardId:string;ownerId:string;projectId:string;createdAt?:number;
    contributors:ManagementContribution[];
    stage?:'prepared'|'merged'|'accepted'|'cleaned';
}
export const managementScopeKey=(id:string)=>'management-operation-scope:'+id;
export const managementScopesKey=(board:string,item:string)=>'management-operation-scopes:'+JSON.stringify([board,item]);
export const integratedContributionKey=(board:string,item:string,dispatch:string)=>'management-integrated:'+JSON.stringify([board,item,dispatch]);


function contributions(board:KanbanBoard,owner:KanbanItem,dispatches:KanbanDispatch[]):Map<string,ManagementContribution[]> {
    const groups=new Map<string,ManagementContribution[]>();
    for(const item of board.items){
        if(item.deletedAt||item.status==='cancelled'||isManagementVerifier(item)||item.planning?.execution==='children'||managementOwner(board,item)?.id!==owner.id)continue;
        const projectId=workProjectId(item);if(!projectId)continue;
        const dispatch=dispatches.filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
        const refs=item.externalRefs?.filter(ref=>ref.system==='nestos-worktree')??[],worktree=refs.length===1?refs[0]:undefined;
        const rows=groups.get(projectId)??[];
        rows.push({itemId:item.id,title:item.title,...(dispatch?{dispatchId:dispatch.id}:{}),...(worktree?{worktreeId:worktree.id}:{})});groups.set(projectId,rows);
    }
    return groups;
}
export async function managementScopes(options:{service:KanbanService;journal:KanbanAutomationJournal;projectLabel(id:string):Promise<string>;repositoryKey?(id:string):string},board:KanbanBoard,owner:KanbanItem):Promise<ManagementScope[]> {
    const workflow=await options.service.workflow(board.id),groups=contributions(board,owner,Object.values(workflow.dispatches));
    const repositories=new Map<string,{projectId:string;rows:ManagementContribution[]}>();
    for(const [projectId,rows] of groups){const key=options.repositoryKey?.(projectId)??projectId,group=repositories.get(key);
        if(group)group.rows.push(...rows);else repositories.set(key,{projectId,rows});}
    const current:ManagementScope[]=[];
    for(const [repository,{projectId,rows}] of repositories){
        rows.sort((a,b)=>a.itemId.localeCompare(b.itemId));
        const receipts=await options.journal.getMany(rows.map(row=>integratedContributionKey(board.id,owner.id,row.dispatchId??row.itemId)));
        const pending=rows.filter((_row,index)=>!receipts[index]);if(!pending.length)continue;
        const id='repository-'+sha256HexSync(JSON.stringify([board.id,owner.id,repository,pending.map(row=>[row.itemId,row.dispatchId])])).slice(0,40);
        current.push({schema:1,id,boardId:board.id,ownerId:owner.id,projectId,label:await options.projectLabel(projectId),contributors:pending});
    }
    const previous=await savedManagementScopes(options.journal,board.id,owner.id);
    return [...previous.filter(scope=>!current.some(row=>row.id===scope.id)),...current];
}
export async function savedManagementScopes(journal:KanbanAutomationJournal,board:string,item:string):Promise<ManagementScope[]> {
    const ids=await journal.get<string[]>(managementScopesKey(board,item))??[];
    const rows=await journal.getMany<ManagementScope>(ids.map(managementScopeKey));
    return rows.filter((row):row is ManagementScope=>!!row&&row.boardId===board&&row.ownerId===item);
}
export async function freezeManagementScope(journal:KanbanAutomationJournal,scope:ManagementScope):Promise<void> {
    await journal.update<ManagementScope>(managementScopeKey(scope.id),old=>{
        requireValue(!old||old.boardId===scope.boardId&&old.ownerId===scope.ownerId&&old.projectId===scope.projectId
            &&JSON.stringify(old.contributors.map(row=>[row.itemId,row.dispatchId,row.worktreeId]))===JSON.stringify(scope.contributors.map(row=>[row.itemId,row.dispatchId,row.worktreeId])),'OPERATION_SCOPE_CHANGED');
        return old??{...scope,createdAt:Date.now(),stage:'prepared'};
    });
    await journal.update<string[]>(managementScopesKey(scope.boardId,scope.ownerId),old=>old?.includes(scope.id)?old:[...old??[],scope.id]);
}

export function isManagementVerifier(item:KanbanItem):boolean {return !!item.externalRefs?.some(ref=>ref.system==='nestos-work-delivery'&&ref.id==='verification');}

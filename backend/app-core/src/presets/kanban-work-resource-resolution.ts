import {sha256HexSync} from '@nestos/common';
import type {KanbanWorkResource,KanbanWorkResourceCleanup,KanbanService} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal,KanbanWorkLog} from '@nestos/kanban/integration';
import {requireValue} from '../kanban/validation';
type Resolution=NonNullable<KanbanWorkResource['resolution']>;
export const workResourceResolutionKey=(board:string,item:string,id:string)=>'work-resource-resolution:'+JSON.stringify([board,item,id]);
export async function resolvedWorkResources<T extends KanbanWorkResource&{itemId?:string}>(journal:KanbanAutomationJournal,board:string,item:string|undefined,rows:T[]):Promise<T[]> {
    if(!rows.length)return rows;
    const saved=await journal.getMany<Resolution>(rows.map(row=>workResourceResolutionKey(board,item??row.itemId!,row.id)));
    return rows.map((row,index)=>saved[index]&&row.state!=='cleaned'?{...row,resolution:saved[index],canCleanup:false}:row);
}
/** Ignore only this association's finalization; never claim removal or change physical resources. */
export async function ignoreWorkResource(options:{service:KanbanService;journal:KanbanAutomationJournal;workLog:KanbanWorkLog},board:string,request:KanbanWorkResourceCleanup,associated:()=>Promise<boolean>):Promise<void> {
    requireValue(/^[\w-]{1,128}$/.test(request.operationId)&&/^[\w-]{1,128}$/.test(request.resourceId),'INVALID_WORK_RESOURCE_CLEANUP');
    requireValue(typeof request.reason==='string'&&request.reason.trim().length>0&&request.reason.length<=1000,'WORK_RESOURCE_IGNORE_REASON_REQUIRED');
    const [state,actor,detail]=await Promise.all([options.service.read(board),options.service.currentPrincipal(),options.service.item(board,request.itemId)]);
    requireValue(actor.kind==='human'&&state.members?.some(row=>row.kind===actor.kind&&row.id===actor.id&&row.roles?.includes('coordinator')),'COORDINATOR_REQUIRED');
    requireValue(['completed','cancelled'].includes(detail.item.status)&&!detail.item.deletedAt,'WORKTREE_TASK_UNFINISHED');
    requireValue(await associated(),'WORKTREE_NOT_ASSOCIATED');
    const reason=request.reason.trim(),fingerprint=sha256HexSync(JSON.stringify([board,request.itemId,request.resourceId,reason]));
    await options.journal.update<{fingerprint:string}>('work-resource-ignore-operation:'+request.operationId,old=>{requireValue(!old||old.fingerprint===fingerprint,'IDEMPOTENCY_CONFLICT');return old??{fingerprint};});
    const resolution=await options.journal.update<Resolution>(workResourceResolutionKey(board,request.itemId,request.resourceId),old=>old??{kind:'ignored',operationId:request.operationId,reason,actor,at:Date.now()});
    await options.workLog.append(options.service,board,request.itemId,{stage:'worktree.ignored',result:'success',actor:resolution.actor,dispatchId:request.resourceId,fields:{operationId:resolution.operationId},references:[{system:'nestos-worktree',id:request.resourceId}]});
}

import {DEFAULT_KANBAN_WORK_TYPES,type KanbanBoard,type KanbanEstimate} from '@nestos/kanban/contracts';
import type {Definition,SavedFix} from '@nestos/kanban/integration';
import {sha256HexSync} from '@nestos/common';
import {requireValue} from './validation';
interface Task {key:string;title:string;responsibility:string;acceptance:string;dependsOn:string[];estimate?:KanbanEstimate}
/** The model provides local keys. The host assigns IDs and confines dependencies and project scope. */
export function coordinationProposal(input:unknown,fix:SavedFix,board:KanbanBoard):Definition {
    const value=input as {schema:string;type:string;tasks:Task[]};
    requireValue(value?.schema==='kanban.coordination-proposal/1'&&value.type==='append'&&Array.isArray(value.tasks)&&value.tasks.length>0&&value.tasks.length<=16,'COORDINATION_PROPOSAL_INVALID');
    const keys=new Map(value.tasks.map(task=>[task?.key,'sub-'+sha256HexSync(JSON.stringify([fix.id,task?.key])).slice(0,40)]));
    requireValue(keys.size===value.tasks.length,'COORDINATION_PROPOSAL_INVALID');
    const existing=new Set(board.items.filter(item=>item.planning?.parentId===fix.itemId&&!item.deletedAt).map(item=>item.id));
    const types=board.workTypes??DEFAULT_KANBAN_WORK_TYPES,rank=types.find(type=>type.id===fix.item.planning?.kind)?.rank;
    const childType=types.filter(type=>type.executable&&rank!==undefined&&type.rank>rank).sort((a,b)=>a.rank-b.rank)[0];
    requireValue(childType&&board.automation,'AUTOMATION_SUBTASK_TYPE_UNAVAILABLE');
    const children=value.tasks.map(task=>{
        validateTask(task,board.policy.requireEstimate!==false);
        requireValue(task.dependsOn.every(key=>(keys.has(key)||existing.has(key))&&key!==task.key),'AUTOMATION_SUBTASK_DEPENDENCY_INVALID');
        return {id:keys.get(task.key)!,workType:childType.id,title:task.title,responsibility:task.responsibility,acceptance:task.acceptance,
            assignee:board.automation!.worker,dependsOn:task.dependsOn.map(key=>keys.get(key)??key),outputs:['result'],estimate:task.estimate,
            externalRefs:fix.item.externalRefs?.filter(ref=>['nestos-remote-project','nestos-decision-run'].includes(ref.system))};
    });
    return {title:fix.item.title,responsibility:fix.item.responsibility,acceptance:fix.item.acceptance,type:'append',dependencies:[],children};
}
function validateTask(task:Task,estimate:boolean) {
    requireValue(task&&/^[a-zA-Z0-9_-]{1,64}$/.test(task.key)&&[task.title,task.responsibility,task.acceptance].every(text=>typeof text==='string'&&text.trim().length>0&&text.length<=8000),'COORDINATION_PROPOSAL_INVALID');
    requireValue(Array.isArray(task.dependsOn)&&task.dependsOn.length<=100&&new Set(task.dependsOn).size===task.dependsOn.length,'AUTOMATION_SUBTASK_DEPENDENCY_INVALID');
    requireValue(!estimate||task.estimate,'ESTIMATE_REQUIRED');
    if(task.estimate)requireValue(['low','medium','high'].includes(task.estimate.confidence)&&[task.estimate.complexity,task.estimate.workUnits,task.estimate.durationMs].every(value=>Number.isFinite(value)&&value>0),'AUTOMATION_ESTIMATE_INVALID');
}

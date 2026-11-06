import {sha256HexSync} from '@nestos/common';
import {journalCommand} from '@nestos/kanban/integration';
import type {KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions,RecoveryIntent} from './task-recovery-ports';
import type {DevelopmentWorkspaceRecord} from '../presets/kanban-development';
import {taskRecoveryState} from './task-recovery-state';
import {taskRecoveryChannels} from './task-recovery-channel';
import {requireValue} from './validation';
export function createTaskRecovery(options:TaskRecoveryOptions) {
    let stopped=false;const pending=new Map<string,Promise<unknown>>();
    const serial=<T>(id:string,work:()=>Promise<T>)=>{requireValue(!stopped,'SERVICE_STOPPING');const next=(pending.get(id)??Promise.resolve()).catch(()=>{}).then(work);pending.set(id,next);void next.finally(()=>{if(pending.get(id)===next)pending.delete(id);}).catch(()=>{});return next;};
    const recoverTask=(boardId:string,request:KanbanTaskRecoveryRequest)=>serial(request.operationId,()=>recover(options,boardId,request));
    const channels=taskRecoveryChannels(options,{recoverTask,inspect:taskRecoveryState,active:()=>!stopped});
    return {taskRecovery:(board:string,item:string)=>taskRecoveryState(options,board,item),recoverTask,openTaskRecovery:channels.open,
        scan:async()=>{await channels.recover();await resumeRepairs(options,()=>!stopped,recoverTask);for(const row of await options.journal.find<RecoveryIntent>('task-recovery-operation:',value=>!value.done)){if(stopped)return;await serial(row.value.request.operationId,()=>settle(options,row.value));}},
        quiesce:async()=>{stopped=true;await channels.close();await Promise.allSettled([...pending.values()]);}};
}
async function recover(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult> {
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)&&['retry','retry-current','fix'].includes(request.action),'INVALID_RECOVERY_REQUEST');
    const key='task-recovery-operation:'+request.operationId,digest=sha256HexSync(JSON.stringify([boardId,request]));
    const saved=await options.journal.get<RecoveryIntent>(key);if(saved){requireValue(saved.digest===digest,'IDEMPOTENCY_CONFLICT');return settle(options,saved);}
    const state=await taskRecoveryState(options,boardId,request.itemId);requireValue(state.revision===request.expectedRevision,'RECOVERY_STALE_REFRESH');
    if(request.action==='fix') {
        const selected=request.sourceItemId??request.itemId;requireValue(selected===request.itemId||state.related.some(row=>row.itemId===selected),'RECOVERY_SCOPE_MISMATCH');
        const item=(await options.service.item(boardId,selected)).item,target=item.planning?.parentId??item.id,client=options.client();requireValue(client.fixTask,'FIX_UNAVAILABLE');
        const fix=await client.fixTask(boardId,{itemId:target,operationId:request.operationId});
        return {operationId:request.operationId,state:'accepted',resourceId:await options.executionResource(fix.sessionId,'main',await options.service.read(boardId))};
    }
    requireValue(request.action==='retry'?state.canRetry:state.canSelectCurrentVersion&&request.confirmed===true,'RECOVERY_TARGET_NOT_READY');
    const workflow=await options.service.workflow(boardId),previous=Object.values(workflow.dispatches).filter(row=>row.itemId===request.itemId).sort((a,b)=>b.attempt-a.attempt)[0];requireValue(previous,'EXECUTION_NOT_FOUND');
    const dispatchId='retry-'+sha256HexSync(request.operationId).slice(0,48),record=await options.journal.get<DevelopmentWorkspaceRecord>('development-workspace:'+previous.id);
    const target=(request.action==='retry-current'||state.deliveryOperationId)?await options.describe((await options.service.item(boardId,request.itemId)).item):undefined;
    requireValue(!target||target.version===state.actualVersion,'RECOVERY_TARGET_CHANGED');
    const intent=await options.journal.update<RecoveryIntent>(key,old=>old??{boardId,request,digest,dispatchId,previousDispatchId:previous.id,targetVersion:target?.version??state.expectedVersion,
        ...(target?{evidence:{version:target.version,serviceId:target.id,approval:request.action==='retry-current'?'user':'delivery-receipt',sourceOperationId:state.deliveryOperationId,sourceItemId:state.deliveryItemId,previous:(record?.context as {delivery?:{evidence?:unknown}})?.delivery?.evidence}}:{}),
        command:{type:'continue-execution',previousDispatchId:previous.id,dispatchId,instruction:'Perform only the failed acceptance checks in this SAME Session. Read the host-frozen recovery receipt in context.recovery; preserve completed siblings and prior failed evidence. Do not redevelop, rebuild or redeploy.'}});
    return settle(options,intent);
}
async function settle(options:TaskRecoveryOptions,intent:RecoveryIntent):Promise<KanbanTaskRecoveryResult> {
    if(intent.done)return intent.result!;
    const board=await options.service.read(intent.boardId);if(board.executionControl?.paused)return {operationId:intent.request.operationId,state:'pending',code:'BOARD_EXECUTION_PAUSED'};
    const ready=await taskRecoveryState(options,intent.boardId,intent.request.itemId);if(ready.blockingItems?.length)return {operationId:intent.request.operationId,state:'pending',code:'RECOVERY_REPAIR_PENDING'};
    if(intent.targetVersion){const current=await options.describe((await options.service.item(intent.boardId,intent.request.itemId)).item);if(current?.version!==intent.targetVersion)return {operationId:intent.request.operationId,state:'pending',code:'RECOVERY_TARGET_CHANGED'};}
    if(intent.evidence)await options.journal.update('task-recovery-evidence:'+intent.dispatchId,old=>old??{schema:1,itemId:intent.request.itemId,previousDispatchId:intent.previousDispatchId,operationId:intent.request.operationId,approved:true,...intent.evidence!});
    await journalCommand(options.journal,options.service,intent.boardId,'task-recovery-command:'+intent.request.operationId,intent.command!);
    const result:KanbanTaskRecoveryResult={operationId:intent.request.operationId,state:'accepted',dispatchId:intent.dispatchId};
    await options.journal.update<RecoveryIntent>('task-recovery-operation:'+intent.request.operationId,old=>({...old!,done:true,result}));
    options.log({operationId:intent.request.operationId,boardId:intent.boardId,stage:'task.recovery.admitted',result:'success',durationMs:0});return result;
}

async function resumeRepairs(options:TaskRecoveryOptions,active:()=>boolean,recoverTask:(board:string,request:KanbanTaskRecoveryRequest)=>Promise<KanbanTaskRecoveryResult>):Promise<void> {
    const rows=await options.journal.find<{fixId:string;boardId:string;itemId:string;done:boolean}>('repair-resumption:',row=>!row.done);
    for(const row of rows) {
        if(!active())return;const pending=row.value,fix=await options.journal.get<{accepted?:boolean}>('fix:'+pending.fixId);if(!fix?.accepted)continue;
        const board=await options.service.read(pending.boardId),item=board.items.find(item=>item.id===pending.itemId);
        if(!item?.repairPending){await options.journal.update(row.key,()=>({...pending,done:true}));continue;}
        if(!board.automation?.enabled||board.executionControl?.paused||board.executionControl?.mode==='manual'||board.lifecycle)continue;
        if(board.items.find(row=>row.id===item.repairPending!.itemId)?.status!=='completed')continue;
        const state=await taskRecoveryState(options,board.id,item.id);if(!state.canRetry)continue;
        await recoverTask(board.id,{operationId:'repair-retry-'+sha256HexSync(JSON.stringify([board.id,item.id,item.repairPending])).slice(0,48),itemId:item.id,action:'retry',expectedRevision:state.revision});
    }
}

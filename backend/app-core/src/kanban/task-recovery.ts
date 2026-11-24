import {reportHandoffFailure} from '@nestos/kanban-development';
import {reloadTaskConfiguration,taskConfigurationStatus} from './task-configuration-reload';
import {resumeCompletedResults} from './task-recovery-results';
import {recoveryWorkspace} from './recovery-workspace';
import {sha256HexSync} from '@nestos/common';
import {resumeCollaborationRepairs,journalCommand,safeCode} from '@nestos/kanban/integration';
import type {KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
import type {TaskRecoveryOptions,RecoveryIntent} from './task-recovery-ports';
import {taskRecoveryState} from './task-recovery-state';
import {taskRecoveryChannels} from './task-recovery-channel';
import {requireValue} from './validation';
export function createTaskRecovery(options:TaskRecoveryOptions) {
    let stopped=false;const pending=new Map<string,Promise<unknown>>();
    const serial=<T>(id:string,work:()=>Promise<T>)=>{requireValue(!stopped,'SERVICE_STOPPING');const next=(pending.get(id)??Promise.resolve()).catch(()=>{}).then(work);pending.set(id,next);void next.finally(()=>{if(pending.get(id)===next)pending.delete(id);}).catch(()=>{});return next;};
    const recoveryKey=(board:string,request:KanbanTaskRecoveryRequest)=>['recheck','reconcile-report'].includes(request.action)?JSON.stringify([board,request.itemId]):request.operationId;
    const recoverTask=(boardId:string,request:KanbanTaskRecoveryRequest)=>serial(recoveryKey(boardId,request),()=>recover(options,boardId,request));
    const channels=taskRecoveryChannels(options,{recoverTask,inspect:taskRecoveryState,active:()=>!stopped});
    return {checkTaskConfiguration:(board:string,item:string)=>checkTaskConfiguration(options,board,item),inspectTaskReports:(board:string,item:string)=>inspectTaskReports(options,board,item),reloadTaskConfiguration:(board:string,request:Parameters<ReturnType<typeof reloadTaskConfiguration>>[1])=>serial('configuration:'+request.operationId,()=>reloadTaskConfiguration(options)(board,request)),taskRecovery:(board:string,item:string)=>taskRecoveryState(options,board,item),recoverTask,openTaskRecovery:channels.open,
        scan:async()=>{await channels.recover();await resumeCompletedResults(options,{active:()=>!stopped,inspect:taskRecoveryState,recoverTask});await resumeRepairs(options,()=>!stopped,recoverTask);for(const row of await options.journal.find<RecoveryIntent>('task-recovery-operation:',value=>!value.done)){if(stopped)return;await serial(recoveryKey(row.value.boardId,row.value.request),()=>settle(options,row.value));}},
        quiesce:async()=>{stopped=true;await channels.close();await Promise.allSettled([...pending.values()]);}};
}
async function checkTaskConfiguration(options:TaskRecoveryOptions,boardId:string,itemId:string){
    const started=Date.now(),operationId='configuration-check-'+sha256HexSync(JSON.stringify([boardId,itemId,started]));
    const event={operationId,boardId,stage:'task.configuration.inspect'};
    try{
        const state=await taskConfigurationStatus(options,boardId,itemId);
        options.log({...event,result:'success',durationMs:Date.now()-started});return state;
    }catch(error){
        options.log({...event,result:'failure',code:safeCode(error,'TASK_CONFIGURATION_CHECK_FAILED'),durationMs:Date.now()-started});throw error;
    }
}

async function inspectTaskReports(options:TaskRecoveryOptions,boardId:string,itemId:string){
    const started=Date.now();
    const dispatch=await latestTaskDispatch(options,boardId,itemId),operationId=dispatch?.id??itemId;
    const event={operationId,boardId,stage:'task.recovery.report-usage'};
    try{
        requireValue(dispatch&&options.reportHandoff?.inspect&&await reportHandoffFailure(options.journal,dispatch.id),'RECOVERY_TARGET_NOT_READY');
        const record=await scopedRecoveryWorkspace(options,{boardId,request:{itemId},previousDispatchId:dispatch.id});
        const usage=await options.reportHandoff.inspect(record);
        options.log({...event,result:'success',durationMs:Date.now()-started});
        return usage;
    }catch(error){
        options.log({...event,result:'failure',code:safeCode(error,'SOFTWARE_REPORT_INSPECTION_FAILED'),durationMs:Date.now()-started});throw error;
    }
}

async function latestTaskDispatch(options:TaskRecoveryOptions,boardId:string,itemId:string){
    const workflow=await options.service.workflow(boardId);
    return Object.values(workflow.dispatches).filter(row=>row.itemId===itemId).sort((a,b)=>b.attempt-a.attempt)[0];
}

async function recover(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult> {
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/.test(request.operationId)&&['retry','retry-current','fix','recheck','reconcile-report'].includes(request.action),'INVALID_RECOVERY_REQUEST');
    if(request.action==='reconcile-report')return reconcileReportHandoff(options,boardId,request);
    const key='task-recovery-operation:'+request.operationId,digest=sha256HexSync(JSON.stringify([boardId,request]));
    const saved=await options.journal.get<RecoveryIntent>(key);if(saved){requireValue(saved.digest===digest,'IDEMPOTENCY_CONFLICT');return settle(options,saved);}
    const state=await taskRecoveryState(options,boardId,request.itemId);requireValue(state.revision===request.expectedRevision,'RECOVERY_STALE_REFRESH');
    if(request.action==='fix') {
        const selected=request.sourceItemId??request.itemId;requireValue(selected===request.itemId||state.related.some(row=>row.itemId===selected),'RECOVERY_SCOPE_MISMATCH');
        const item=(await options.service.item(boardId,selected)).item,target=item.planning?.parentId??item.id,client=options.client();requireValue(client.fixTask,'FIX_UNAVAILABLE');
        const fix=await client.fixTask(boardId,{itemId:target,operationId:request.operationId});
        return {operationId:request.operationId,state:'accepted',resourceId:await options.executionResource(fix.sessionId,'main',await options.service.read(boardId))};
    }
    if(request.action==='recheck'&&state.reportHandoff)return requestReportHandoff(options,boardId,request,digest,state.reportHandoff.canRecheck);
    requireValue(request.action==='recheck'?state.canRecheck:request.action==='retry'?state.canRetry:state.canSelectCurrentVersion&&request.confirmed===true,'RECOVERY_TARGET_NOT_READY');
    const workflow=await options.service.workflow(boardId),previous=Object.values(workflow.dispatches).filter(row=>row.itemId===request.itemId).sort((a,b)=>b.attempt-a.attempt)[0];requireValue(previous,'EXECUTION_NOT_FOUND');
    if(request.action==='recheck'&&state.state==='blocked'){
        const intent=await options.journal.update<RecoveryIntent>(key,old=>old??{boardId,request,digest,previousDispatchId:previous.id,dispatchId:previous.id,issueId:state.pendingIssueIds![0]});
        return settle(options,intent);
    }
    const dispatchId='retry-'+sha256HexSync(request.operationId).slice(0,48),record=(await recoveryWorkspace(options.journal,workflow,previous))?.record;
    const target=(request.action==='retry-current'||state.deliveryOperationId)?await options.describe((await options.service.item(boardId,request.itemId)).item):undefined;
    requireValue(!target||target.version===state.actualVersion,'RECOVERY_TARGET_CHANGED');
    const intent=await options.journal.update<RecoveryIntent>(key,old=>old??{boardId,request,digest,dispatchId,previousDispatchId:previous.id,targetVersion:target?.version??state.expectedVersion,
        ...(target?{evidence:{version:target.version,serviceId:target.id,approval:request.action==='retry-current'?'user':'delivery-receipt',sourceOperationId:state.deliveryOperationId,sourceItemId:state.deliveryItemId,previous:(record?.context as {delivery?:{evidence?:unknown}})?.delivery?.evidence}}:{}),
        command:{type:'continue-execution',previousDispatchId:previous.id,dispatchId,instruction:request.action==='recheck'?'The host verified the declared prerequisites. Resume the unfinished task in this same Session and worktree. Read the current task context and prerequisites.json, and apply any declared binDirectories to the command PATH. Preserve completed work and all prior evidence.': 'Perform only the failed acceptance checks in this SAME Session. Read the host-frozen recovery receipt in context.recovery; preserve completed siblings and prior failed evidence. Do not redevelop, rebuild or redeploy.'}});
    return settle(options,intent);
}
async function requestReportHandoff(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest,digest:string,allowed:boolean):Promise<KanbanTaskRecoveryResult>{
    requireValue(allowed,'RECOVERY_TARGET_NOT_READY');
    const previous=await latestTaskDispatch(options,boardId,request.itemId);
    requireValue(previous,'EXECUTION_NOT_FOUND');
    const current=await options.journal.get<import('@nestos/kanban/contracts').KanbanRecoveryReceipt>('task-report-recovery:'+previous.id);
    if(current?.state==='pending')return {operationId:current.operationId,state:'pending',...(current.code?{code:current.code}:{})};
    const intent=await options.journal.update<RecoveryIntent>('task-recovery-operation:'+request.operationId,old=>old??{
        boardId,request,digest,dispatchId:previous.id,previousDispatchId:previous.id,reportHandoff:true});
    requireValue(intent.digest===digest,'IDEMPOTENCY_CONFLICT');
    await trackReportReceipt(options,intent,{operationId:request.operationId,state:'pending'});
    return settle(options,intent);
}

async function reconcileReportHandoff(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest):Promise<KanbanTaskRecoveryResult>{
    const {itemId,operationId}=request,started=Date.now(),event={operationId,boardId,stage:'task.recovery.report-reconcile'};
    const originalKey='task-recovery-operation:'+operationId;
    const intent=await options.journal.get<RecoveryIntent>(originalKey);
    const state=await taskRecoveryState(options,boardId,itemId);
    requireValue(state.revision===request.expectedRevision,'RECOVERY_STALE_REFRESH');
    requireValue(intent?.reportHandoff&&intent.boardId===boardId&&intent.request.itemId===itemId,'RECOVERY_SCOPE_MISMATCH');
    if(state.reportReceipt?.operationId===operationId)return {operationId,state:state.reportReceipt.state};
    requireValue(state.reportHandoff?.canRecheck&&state.reportHandoff.receipt?.operationId===operationId
        &&state.reportHandoff.receipt.state==='pending'&&options.reportHandoff,'RECOVERY_TARGET_NOT_READY');
    let result:KanbanTaskRecoveryResult;
    try{
        await options.reportHandoff.run(boardId,itemId,intent.dispatchId,true);
        options.reportHandoff.wake();
        result={operationId,state:'pending',code:'REPORT_HANDOFF_SETTLEMENT_PENDING'};
        options.log({...event,result:'success',durationMs:Date.now()-started});
    }catch(error){
        const code=safeCode(error,'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED');
        result={operationId,state:'pending',code};
        options.log({...event,result:'failure',code,durationMs:Date.now()-started});
    }
    await options.journal.update<RecoveryIntent>(originalKey,old=>({...old!,done:true,result}));
    await trackReportReceipt(options,intent,result);
    return result;
}

async function recheckReportHandoff(options:TaskRecoveryOptions,intent:RecoveryIntent):Promise<KanbanTaskRecoveryResult>{
    const {boardId,request,dispatchId}=intent,{operationId,itemId}=request,started=Date.now();
    const event={operationId,boardId,stage:'task.recovery.report-handoff'};
    try{
        const state=await taskRecoveryState(options,boardId,itemId);
        requireValue(state.reportHandoff?.canRecheck&&state.revision===request.expectedRevision&&options.reportHandoff,'RECOVERY_STALE_REFRESH');
        await options.reportHandoff.run(boardId,itemId,dispatchId);
        options.reportHandoff.wake();
        options.log({...event,result:'success',durationMs:Date.now()-started});
        return finishRecovery(options,intent,{operationId,state:'pending',code:'REPORT_HANDOFF_SETTLEMENT_PENDING'});
    }catch(error){
        const code=safeCode(error,'SOFTWARE_REPORT_HANDOFF_UNCONFIRMED');
        options.log({...event,result:'failure',code,durationMs:Date.now()-started});
        const uncertain=['ECANCELLED','ETIMEDOUT','SOFTWARE_REPORT_HANDOFF_UNCONFIRMED'].includes(code);
        if(uncertain)options.reportHandoff?.wake();
        return finishRecovery(options,intent,{operationId,state:uncertain?'pending':'blocked',code});
    }
}

async function recheckReportedIssue(options:TaskRecoveryOptions,intent:RecoveryIntent):Promise<KanbanTaskRecoveryResult> {
    const {boardId,request,previousDispatchId:attemptId,issueId}=intent,{operationId,itemId}=request;
    const replyId='recheck-'+sha256HexSync(JSON.stringify([boardId,itemId,attemptId,issueId]));
    if(await options.journal.get('task-reply-delivered:'+replyId))return finishRecovery(options,intent,{operationId,state:'accepted'});
    const current=await taskRecoveryState(options,boardId,itemId),client=options.client();
    requireValue(client.replyTask,'WORKSPACE_REPLY_UNAVAILABLE');
    if(!current.canRecheck||current.revision!==request.expectedRevision)
        return finishRecovery(options,intent,{operationId,state:'blocked',code:'RECOVERY_STALE_REFRESH'});
    const record=await scopedRecoveryWorkspace(options,intent);
    const blocked=await recheck(options,boardId,request,record);
    if(blocked)return finishRecovery(options,intent,blocked);
    const fresh=await taskRecoveryState(options,boardId,itemId);
    if(!fresh.canRecheck||fresh.revision!==request.expectedRevision)
        return finishRecovery(options,intent,{operationId,state:'blocked',code:'RECOVERY_STALE_REFRESH'});
    const content='The host verified the declared workspace prerequisites. Recheck the reported issue in this same Session and workspace. If fixed, publish a resolved report linked to the original issue and continue the unfinished work. If it persists, report the concrete blocker. Read prerequisites.json and use the declared binDirectories for command PATH.';
    await client.replyTask(boardId,{itemId,attemptId,replyTo:issueId!,operationId:replyId,content});
    if(!await options.journal.get('task-reply-delivered:'+replyId))return {operationId,state:'pending',code:'WORKSPACE_REPLY_UNCONFIRMED'};
    return finishRecovery(options,intent,{operationId,state:'accepted'});
}

async function recheck(options:TaskRecoveryOptions,boardId:string,request:KanbanTaskRecoveryRequest,record:import('../presets/kanban-development').DevelopmentWorkspaceRecord|undefined):Promise<KanbanTaskRecoveryResult|undefined> {
    const operationId=request.operationId,started=Date.now(),event={operationId,boardId,stage:'task.recovery.prerequisites'};
    try {
        requireValue(record&&options.recheck?.supports(record),'WORKSPACE_PREREQUISITES_UNAVAILABLE');
        const missing=await options.recheck!.run(record),code=missing.length?'WORKSPACE_PREREQUISITES_MISSING':undefined;
        options.log({...event,result:code?'failure':'success',code,durationMs:Date.now()-started});
        if(code)return {operationId,state:'blocked',code,missing};
    }catch(error){
        const code=safeCode(error,'WORKSPACE_PREREQUISITES_UNCONFIRMED');
        options.log({...event,result:'failure',code,durationMs:Date.now()-started});
        return {operationId,state:'blocked',code};
    }
}
async function settle(options:TaskRecoveryOptions,intent:RecoveryIntent):Promise<KanbanTaskRecoveryResult> {
    if(intent.done)return intent.result!;
    const board=await options.service.read(intent.boardId);if(board.executionControl?.paused)return {operationId:intent.request.operationId,state:'pending',code:'BOARD_EXECUTION_PAUSED'};
    if(intent.reportHandoff)return recheckReportHandoff(options,intent);
    if(intent.issueId)return recheckReportedIssue(options,intent);
    const ready=await taskRecoveryState(options,intent.boardId,intent.request.itemId);if(ready.blockingItems?.length)return {operationId:intent.request.operationId,state:'pending',code:'RECOVERY_REPAIR_PENDING'};
    if(intent.targetVersion){const current=await options.describe((await options.service.item(intent.boardId,intent.request.itemId)).item);if(current?.version!==intent.targetVersion)return {operationId:intent.request.operationId,state:'pending',code:'RECOVERY_TARGET_CHANGED'};}
    const commandKey='task-recovery-command:'+intent.request.operationId;
    if(intent.request.action==='recheck'&&!await options.journal.get(commandKey)){
        if(!ready.canRecheck||ready.revision!==intent.request.expectedRevision)
            return finishRecovery(options,intent,{operationId:intent.request.operationId,state:'blocked',code:'RECOVERY_STALE_REFRESH'});
        const blocked=await recheck(options,intent.boardId,intent.request,await scopedRecoveryWorkspace(options,intent));
        if(blocked)return finishRecovery(options,intent,blocked);
    }
    if(intent.evidence)await options.journal.update('task-recovery-evidence:'+intent.dispatchId,old=>old??{schema:1,itemId:intent.request.itemId,previousDispatchId:intent.previousDispatchId,operationId:intent.request.operationId,approved:true,...intent.evidence!});
    await journalCommand(options.journal,options.service,intent.boardId,commandKey,intent.command!);
    options.log({operationId:intent.request.operationId,boardId:intent.boardId,stage:'task.recovery.admitted',result:'success',durationMs:0});
    return finishRecovery(options,intent,{operationId:intent.request.operationId,state:'accepted',dispatchId:intent.dispatchId});
}

async function scopedRecoveryWorkspace(options:TaskRecoveryOptions,intent:{boardId:string;request:{itemId:string};previousDispatchId:string}) {
    const workflow=await options.service.workflow(intent.boardId);
    const previous=workflow.dispatches[intent.previousDispatchId];
    const {item}=await options.service.item(intent.boardId,intent.request.itemId);
    const retained=await recoveryWorkspace(options.journal,workflow,previous),record=retained?.record;
    requireValue(record&&!await options.journal.get('worktree-cleanup:'+(record.worktreeId??previous.id))&&item.externalRefs?.some(ref=>ref.system==='nestos-remote-project'&&ref.id===record.projectId),'RECOVERY_SCOPE_MISMATCH');
    return record;
}

async function finishRecovery(options:TaskRecoveryOptions,intent:RecoveryIntent,result:KanbanTaskRecoveryResult) {
    const saved=await options.journal.update<RecoveryIntent>('task-recovery-operation:'+intent.request.operationId,old=>old?.done?old:{...old!,done:true,result});
    if(intent.reportHandoff)await trackReportReceipt(options,intent,saved.result!);
    return saved.result!;
}

async function trackReportReceipt(options:TaskRecoveryOptions,intent:RecoveryIntent,result:KanbanTaskRecoveryResult){
    const key='task-report-recovery:'+intent.dispatchId;
    await options.journal.update<import('@nestos/kanban/contracts').KanbanRecoveryReceipt>(key,old=>
        old?.operationId!==result.operationId&&result.code!==undefined?old??{...result,checkedAt:Date.now()}:{...result,checkedAt:Date.now()});
}

async function resumeRepairs(options:TaskRecoveryOptions,active:()=>boolean,recoverTask:(board:string,request:KanbanTaskRecoveryRequest)=>Promise<KanbanTaskRecoveryResult>):Promise<void> {
    await resumeCollaborationRepairs(options.service,options.journal,active,async(boardId,item,operationId)=>{
        const state=await taskRecoveryState(options,boardId,item.id);if(!state.canRetry)return;
        await recoverTask(boardId,{operationId,itemId:item.id,action:'retry',expectedRevision:state.revision});
    });
}

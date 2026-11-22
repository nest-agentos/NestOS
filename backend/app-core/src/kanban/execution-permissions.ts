import {sha256HexSync} from '@nestos/common';
import {safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
import {IndependentCallCommand,type IndependentCallInteractionDetail,type IndependentCallResponseQuery,type IndependentCallResponseReceipt,type IndependentCallView} from '@nestos/llm-session/contracts';

export interface ExecutionPermissionPorts {
    journal: KanbanAutomationJournal;
    execute<T>(command:string,request:unknown):Promise<T>;
    log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
    decide(request:Record<string,unknown>):Promise<{decision:'allow'}|{decision:'manual';code:string}>;
    canAnswer():Promise<boolean>;
}

interface ApprovalIntent {
    phase:'prepared'|'submitting'|'committed';
    query:IndependentCallResponseQuery;
}

export async function answerExecutionPermissions(ports:ExecutionPermissionPorts, boardId:string, call:IndependentCallView) {
    for(const interaction of call.interactions?.items??[]){
        if(interaction.kind!=='approval')continue;
        const query=responseQuery(call,interaction);
        if(!query)continue;
        const started=Date.now(),context={operationId:query.requestId,boardId};
        try {
            const outcome=await answer(ports,query);
            if(outcome)ports.log({...context,stage:'execution.permission',...outcome,durationMs:Date.now()-started});
        }catch(error){
            ports.log({...context,stage:'execution.permission',result:'failure',code:safeCode(error,'PERMISSION_RESPONSE_UNAVAILABLE'),durationMs:Date.now()-started});
        }
    }
}

function responseQuery(call:IndependentCallView,interaction:{taskId:string;interactionId:string;requestedAt:number}):IndependentCallResponseQuery|undefined {
    const {operationId:callId,callerSessionId:sessionId,executionSessionId,execution}=call.receipt;
    const branchId=call.input.request.expectedBranch;
    if(!executionSessionId||execution?.role!=='primary'||!branchId||!call.controlCapabilities?.respond)return;
    const scope={sessionId,branchId,callId,executionSessionId,taskId:execution.taskId,targetTaskId:interaction.taskId,interactionId:interaction.interactionId};
    return {...scope,requestId:'kanban-approval-'+sha256HexSync(JSON.stringify([scope,interaction.requestedAt]))};
}

async function answer(ports:ExecutionPermissionPorts,query:IndependentCallResponseQuery) {
    const key='execution-permission:'+query.requestId;
    const intent=await ports.journal.get<ApprovalIntent>(key);
    if(intent?.phase==='committed')return;
    if(intent?.phase==='submitting')return observePermission(ports,key,intent.query);
    const detail=await ports.execute<IndependentCallInteractionDetail>(IndependentCallCommand.Interaction,query);
    const payload=detail.interaction.payload;
    if(detail.interaction.kind!=='approval'||detail.interaction.status!=='pending'||!payload||typeof payload!=='object'||Array.isArray(payload))return;
    const verdict=await ports.decide(payload);
    if(verdict.decision==='manual')return {result:'failure' as const,code:verdict.code};
    if(!await ports.canAnswer())return {result:'failure' as const,code:'PERMISSION_TASK_SCOPE_CHANGED'};
    const saved=await ports.journal.update<ApprovalIntent>(key,old=>old??{phase:'prepared',query});
    if(saved.phase!=='prepared'||!await ports.journal.claim(key))return;
    try {
        const result=await ports.execute<IndependentCallResponseReceipt>(IndependentCallCommand.Respond,{...query,value:{decision:'accept'}});
        return settlePermission(ports,key,query,result);
    }catch(error){
        const observed=await ports.execute<IndependentCallResponseReceipt>(IndependentCallCommand.ResponseReceipt,query);
        if(!observed.receipt)throw error;
        return settlePermission(ports,key,query,observed);
    }
}

async function observePermission(ports:ExecutionPermissionPorts,key:string,query:IndependentCallResponseQuery) {
    return settlePermission(ports,key,query,await ports.execute(IndependentCallCommand.ResponseReceipt,query));
}

async function settlePermission(ports:ExecutionPermissionPorts,key:string,query:IndependentCallResponseQuery,observed:IndependentCallResponseReceipt) {
    const receipt=observed.receipt;
    if(!receipt)return {result:'failure' as const,code:'PERMISSION_RESPONSE_UNCONFIRMED'};
    if(receipt.requestId!==query.requestId||receipt.taskId!==query.targetTaskId||receipt.interactionId!==query.interactionId)
        return {result:'failure' as const,code:'PERMISSION_RESPONSE_SCOPE_CHANGED'};
    await ports.journal.update<ApprovalIntent>(key,old=>({...old!,phase:'committed'}));
    return {result:'success' as const,code:'PERMISSION_RESPONSE_COMMITTED'};
}

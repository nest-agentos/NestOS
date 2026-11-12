import {taskStat,type Kernel,type TaskCallResult} from '@nestos/durable-kernel';
import type {IndependentCallService} from './independent-calls';
import type {IndependentCallInput} from '../contracts/independent-calls';
import type {IndependentTaskCallAdmission} from './independent-call-preparation';
import {independentCallSettled} from './durable-call-control';
import {reconcileIndependentCallExecution,type CallReconciliationDiagnostic} from './independent-call-reconciliation';
export interface IndependentCallExecutionPorts {
    calls:Pick<IndependentCallService,'inspectTaskCallSubmission'|'list'>;
    kernel:Pick<Kernel,'task'>&Partial<Pick<Kernel,'resolveEffect'>>;
    log?(event:CallReconciliationDiagnostic):void;
}
export interface IndependentCallExecutionObservation {
    outcome:'unknown'|'running'|'failed'|'cancelled'|'succeeded';code?:string;sessionId?:string;output?:unknown;
    controlCapabilities?:{pause:'boundary'|'none';resume:boolean};
}
export interface IndependentCallExecutionReader {
    inspect(input:IndependentCallInput):Promise<IndependentCallExecutionObservation>;
    wait(receipt:IndependentTaskCallAdmission,timeoutMs:number):Promise<IndependentCallExecutionObservation>;
    settled(sessionId:string):Promise<boolean>;
}
/** Kernel handles stay inside Session; applications consume execution observations. */
export function createIndependentCallExecutionReader(ports:IndependentCallExecutionPorts&{kernel:IndependentCallExecutionPorts['kernel']&Pick<Kernel,'attachTask'|'listSessionTasks'>}):IndependentCallExecutionReader {
    return {inspect:input=>inspectIndependentCallExecution(ports,input),
        wait:async(receipt,timeoutMs)=>{
            const caller=await ports.kernel.attachTask(receipt.submission.task.sessionId,receipt.submission.task.taskId);
            const exit=await caller.wait({until:'settled',timeoutMs});
            const result=exit.output as TaskCallResult|undefined;
            if(exit.status!=='succeeded')return {outcome:exit.status==='cancelled'?'cancelled':'failed',code:knownCode(exit.error,'CALLER_FAILED')};
            if(!result?.exit)return {outcome:'unknown',code:'CALL_RESULT_MISSING'};
            return {outcome:result.exit.status,output:result.exit.output,code:result.exit.error?.code};
        },settled:async sessionId=>{
            const callers=(await ports.kernel.listSessionTasks(sessionId)).filter(task=>task.program.kind==='kernel.call');
            if(!callers.length)return false;
            for(const caller of callers)if(!(await(await ports.kernel.attachTask(sessionId,caller.id)).stat()).settled)return false;
            return true;
        }};
}
/** Observe the admitted call and its owned tree; reports and idle conversations are not completion facts. */
export async function inspectIndependentCallExecution(ports:IndependentCallExecutionPorts,input:IndependentCallInput):Promise<IndependentCallExecutionObservation> {
    const admission=await ports.calls.inspectTaskCallSubmission(input);
    if(!admission)return {outcome:'unknown',code:'WORK_ADMISSION_UNKNOWN'};
    const views=await ports.calls.list({sessionId:input.request.expectedSessionId!,branchId:input.request.expectedBranch});
    const view=views.find(view=>view.input.request.submission?.id===input.request.submission?.id);
    const session={...(admission.executionSessionId?{sessionId:admission.executionSessionId}:{}),...(view?.controlCapabilities?{controlCapabilities:{pause:view.controlCapabilities.pause??'none',resume:view.controlCapabilities.resume===true}}:{})};
    if(!view)return {...session,outcome:'unknown',code:'WORK_EXECUTION_VIEW_MISSING'};
    if(view.callerState&&!view.callerState.settled){
        const blocked=await reconcileIndependentCallExecution(ports.kernel,admission.executionSessionId,view.executionState,ports.log);
        return {...session,outcome:blocked?'unknown':'running',...(blocked?{code:'WORK_EXECUTION_UNSETTLED'}:{})};
    }
    if(!independentCallSettled(view))return {...session,outcome:'unknown',code:'WORK_EXECUTION_UNSETTLED'};
    const record=await ports.kernel.task(admission.submission.task.sessionId,admission.submission.task.taskId),stat=taskStat(record);
    if(!stat.settled||!record.exit)return {...session,outcome:'unknown',code:'WORK_CALLER_UNSETTLED'};
    if(record.exit.status!=='succeeded')return {...session,outcome:record.exit.status==='cancelled'?'cancelled':'failed',code:knownCode(record.exit.error,'WORK_CALLER_FAILED')};
    const result=record.exit.output as TaskCallResult|undefined;
    if(!result?.exit)return {...session,outcome:'unknown',code:'WORK_RESULT_MISSING'};
    if(result.exit.status!=='succeeded')return {...session,outcome:result.exit.status==='cancelled'?'cancelled':'failed',code:knownCode(result.exit.error,'WORK_EXECUTION_FAILED')};
    return {...session,outcome:'succeeded',output:result.exit.output};
}
function knownCode(error:unknown,fallback:string):string {
    const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:fallback;
}

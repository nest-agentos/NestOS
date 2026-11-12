import {sha256HexSync} from '@nestos/llm-context';
import type {Kernel} from '@nestos/durable-kernel';
import type {IndependentCallView} from '../contracts/independent-calls';
const transient=new Set(['EIO','ETIMEDOUT','ECONNRESET','ECONNREFUSED','ENETUNREACH','NATIVE_DISCONNECTED','NATIVE_EPOCH_CHANGED','CONNECTION_STILL_RUNNING','CONNECTION_STATE_UNKNOWN']);
export interface CallReconciliationDiagnostic {operationId:string;sessionId:string;taskId:string;effectId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}
type Ports=Pick<Kernel,'task'>&Partial<Pick<Kernel,'resolveEffect'>>;
/** Reconciliation observes the admitted effect; it never authorizes replay or fabricates a result. */
export async function reconcileIndependentCallExecution(kernel:Ports,sessionId:string|undefined,state:IndependentCallView['executionState'],log?:(event:CallReconciliationDiagnostic)=>void):Promise<boolean> {
    if(!sessionId||!state||state.settled||!['effect','any','all'].includes(state.blockedBy??'')||state.control?.requested!=='run')return false;
    const task=await kernel.task(sessionId,state.id);
    if(task.sessionId!==sessionId||task.id!==state.id)throw Object.assign(new Error('Execution identity mismatch'),{code:'WORK_EXECUTION_SCOPE_MISMATCH'});
    const effects=Object.entries(task.effects).filter(([,effect])=>effect.status==='indeterminate');
    const reconciling=Object.values(task.effects).some(effect=>['pending','leased'].includes(effect.status)&&!effect.replayAuthorized&&effect.attempts.some(attempt=>attempt.outcome==='indeterminate'));
    if(task.sessionPaused||task.controlHolds?.length||task.control&&task.control.mode!=='run')return effects.length>0||reconciling;
    for(const [effectId,effect] of effects){
        const previous=effect.attempts.at(-1),delay=Math.min(60000,1000*2**Math.min(effect.attemptCount,6));
        if(!kernel.resolveEffect||!transient.has(effect.error?.code??'')||Date.now()-(previous?.finishedAt??Date.now())<delay)continue;
        const started=Date.now(),requestId='work-reconcile-'+sha256HexSync(JSON.stringify([sessionId,task.id,effectId,previous?.id])).slice(0,48);
        try{
            await kernel.resolveEffect(sessionId,task.id,{requestId,effectId,outcome:{type:'reconcile'}});
            log?.({operationId:requestId,sessionId,taskId:task.id,effectId,stage:'reconcile.request',result:'success',durationMs:Date.now()-started});
        }catch(error){
            const code=(error as {code?:string}).code;
            log?.({operationId:requestId,sessionId,taskId:task.id,effectId,stage:'reconcile.request',result:'failure',code:code&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'WORK_RECONCILIATION_PENDING',durationMs:Date.now()-started});
        }
    }
    return effects.length>0||reconciling;
}

import {IndependentCallCommand,type IndependentCallView,type IndependentCallStateControlRequest,type IndependentCallCancelRequest} from '../contracts/independent-calls';
import {assertCallControl,type DurableCallControlRequest,type CallControlAction} from './durable-call-control-ports';
export interface FrozenCallControl {phase:'prepared'|'submitting';action?:CallControlAction;command:string;query:IndependentCallStateControlRequest|IndependentCallCancelRequest}
/** Older state-control journals stored only the query; its action determines this route unambiguously. */
export function normalizeCallControl(frozen:FrozenCallControl):FrozenCallControl{
    const action=(frozen?.query as IndependentCallStateControlRequest|undefined)?.action;
    return !frozen?.command&&['pause','resume','withdraw'].includes(action??'')?{...frozen,command:IndependentCallCommand.Control}:frozen;
}
export function validateCallControl(frozen:FrozenCallControl,request:DurableCallControlRequest,view?:IndependentCallView):void{
    const query=frozen?.query;
    assertCallControl(query&&['prepared','submitting'].includes(frozen.phase),'CALL_CONTROL_RECORD_INVALID');
    const cancel=[IndependentCallCommand.Cancel,IndependentCallCommand.CancelRemaining].includes(frozen.command as never);
    const action=frozen.action??(cancel?'cancel':(query as IndependentCallStateControlRequest).action==='withdraw'?'resume':(query as IndependentCallStateControlRequest).action);
    assertCallControl(query.sessionId===request.sessionId&&query.requestId===request.requestId&&query.callId===request.callId&&query.branchId==='main'&&action===request.action,'CALL_CONTROL_IDEMPOTENCY_CONFLICT');
    assertCallControl(cancel?request.action==='cancel':frozen.command===IndependentCallCommand.Control&&request.action!=='cancel','CALL_CONTROL_RECORD_INVALID');
    const routed=(query as IndependentCallStateControlRequest).action;
    assertCallControl(cancel?routed===undefined:action==='pause'?routed==='pause':routed==='resume'||routed==='withdraw','CALL_CONTROL_RECORD_INVALID');
    if(view)assertCallControl(query.executionSessionId===view.receipt.executionSessionId&&(query.taskId===view.executionState?.id||!view.executionState&&view.callerState?.settled===true&&view.executionTree?.settled===true),'CALL_CONTROL_SCOPE_MISMATCH');
}
export function freezeCallControl(view:IndependentCallView,request:DurableCallControlRequest):FrozenCallControl{
    const capability=view.controlCapabilities,state=view.executionState,{action}=request;
    const withdraw=action==='resume'&&state?.control?.requested==='pause'&&!state.control.acknowledged;
    assertCallControl(action==='cancel'?capability?.cancel:withdraw?capability?.withdrawPause:action==='pause'?capability?.pause==='boundary':capability?.resume,'CALL_CONTROL_UNSUPPORTED');
    assertCallControl(state&&view.receipt.executionSessionId,'CALL_CONTROL_ROUTE_MISSING');
    const remaining=action==='cancel'&&state.settled;
    assertCallControl(!remaining||capability?.cancelRemaining,'CALL_CONTROL_UNSUPPORTED');
    return {phase:'prepared',action,command:action==='cancel'?remaining?IndependentCallCommand.CancelRemaining:IndependentCallCommand.Cancel:IndependentCallCommand.Control,
        query:{sessionId:request.sessionId,branchId:'main',callId:request.callId,executionSessionId:view.receipt.executionSessionId,taskId:state.id,requestId:request.requestId,expectedEpoch:state.controlEpoch,...(action==='cancel'?{}:{action:withdraw?'withdraw' as const:action})}};
}

import {IndependentCallCommand,type IndependentCallView,type IndependentCallStateControlRequest,type IndependentCallCancelRequest} from '../contracts/independent-calls';
import {normalizeCallControl,freezeCallControl,validateCallControl,type FrozenCallControl} from './durable-call-control-policy';
import {assertCallControl,type CallControlAction,type CallControlOutcome,type DurableCallControlRequest,type CallControlJournal,type DurableCallControlPorts} from './durable-call-control-ports';
export {CallControlError,type CallControlAction,type CallControlOutcome,type DurableCallControlRequest,type CallControlJournal,type DurableCallControlPorts} from './durable-call-control-ports';
export function independentCallSettled(view:IndependentCallView):boolean{return view.callerState?.settled===true&&view.executionTree?.settled===true;}
/** Only the first claimant writes; uncertain outcomes inspect the original request. */
export async function controlIndependentCall(ports:DurableCallControlPorts,journal:CallControlJournal,request:DurableCallControlRequest,keys?:{key:string;legacyKey?:string}):Promise<CallControlOutcome>{
    const started=Date.now();let outcome:CallControlOutcome|undefined,code:string|undefined;
    try {outcome=await advance(ports,journal,structuredClone(request),keys);return outcome;}
    catch(error){code=controlCode(error);throw error;}
    finally{try{ports.log?.({operationId:request.requestId,stage:'control',result:code||outcome==='unknown'?'failure':'success',code:code??(outcome==='unknown'?'CALL_CONTROL_RECEIPT_MISSING':undefined),durationMs:Date.now()-started,outcome});}catch{/* Logging cannot replace the durable outcome. */}}
}
async function advance(ports:DurableCallControlPorts,journal:CallControlJournal,request:DurableCallControlRequest,keys?:{key:string;legacyKey?:string}):Promise<CallControlOutcome>{
    assertCallControl(['pause','resume','cancel'].includes(request.action)&&[request.sessionId,request.callId,request.requestId].every(value=>typeof value==='string'&&value.length>0&&value.length<=256),'CALL_CONTROL_REQUEST_INVALID');
    const key=keys?.key??'independent-call-control:'+JSON.stringify([request.sessionId,request.requestId]);
    let frozen=await journal.get<FrozenCallControl>(key)??(keys?.legacyKey?await journal.get<FrozenCallControl>(keys.legacyKey):undefined);
    if(frozen){frozen=normalizeCallControl(frozen);validateCallControl(frozen,request);}
    const view=await findCall(ports,request);
    assertCallControl(view,frozen?'CALL_CONTROL_ROUTE_MISSING':'CALL_CONTROL_NOT_FOUND');
    await journal.update<DurableCallControlRequest&{executionSessionId?:string}>(key+':request',old=>{
        assertCallControl(!old||old.sessionId===request.sessionId&&old.callId===request.callId&&old.requestId===request.requestId&&old.action===request.action,'CALL_CONTROL_IDEMPOTENCY_CONFLICT');
        assertCallControl(!old?.executionSessionId||old.executionSessionId===view.receipt.executionSessionId,'CALL_CONTROL_SCOPE_MISMATCH');
        return {...old??request,executionSessionId:view.receipt.executionSessionId};
    });
    if(!frozen&&independentCallSettled(view))return settled(request.action);
    frozen=await journal.update<FrozenCallControl>(key,old=>old?normalizeCallControl(old):frozen??freezeCallControl(view,request));
    validateCallControl(frozen,request,view);
    if(independentCallSettled(view))return settled(request.action);
    const submit=await journal.claim(key),{expectedEpoch:_epoch,...query}=frozen.query;
    if(request.action==='cancel')return cancel(ports,request,frozen,submit,query as IndependentCallCancelRequest);
    assertCallControl(ports.callControl,'CALL_CONTROL_UNSUPPORTED');
    const result=await ports.callControl(submit?IndependentCallCommand.Control:IndependentCallCommand.ControlReceipt,(submit?frozen.query:query) as IndependentCallStateControlRequest);
    if(!result.receipt)return 'unknown';
    return result.receipt.current?.requestId===request.requestId&&result.receipt.current.acknowledged?settled(request.action):'accepted';
}
async function findCall(ports:DurableCallControlPorts,request:DurableCallControlRequest){return (await ports.calls.list({sessionId:request.sessionId,branchId:'main'})).find(v=>v.input.request.submission?.id===request.callId);}
function settled(action:CallControlAction):CallControlOutcome{return action==='pause'?'paused':action==='resume'?'resumed':'cancelled';}
async function cancel(ports:DurableCallControlPorts,request:DurableCallControlRequest,frozen:FrozenCallControl,submit:boolean,query:IndependentCallCancelRequest):Promise<CallControlOutcome>{
    assertCallControl(ports.callCancel,'CALL_CONTROL_UNSUPPORTED');
    const command=submit?frozen.command:frozen.command===IndependentCallCommand.CancelRemaining?IndependentCallCommand.TreeCancellationReceipt:IndependentCallCommand.CancellationReceipt;
    const result=await ports.callCancel(command,(submit?frozen.query:query) as IndependentCallCancelRequest);
    if(!result.receipt)return 'unknown';
    const latest=await findCall(ports,request);return latest&&independentCallSettled(latest)?'cancelled':'accepted';
}

function controlCode(error:unknown):string{const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code)?code:'CALL_CONTROL_FAILED';}

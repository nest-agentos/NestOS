import type {IndependentCallView,IndependentCallStateControlRequest,IndependentCallStateControlReceipt,IndependentCallCancelRequest,IndependentCallCancellationReceipt,IndependentCallTreeCancellationReceipt} from '../contracts/independent-calls';
export type CallControlAction='pause'|'resume'|'cancel';
export type CallControlOutcome='accepted'|'paused'|'resumed'|'cancelled'|'unknown';
export interface DurableCallControlRequest {sessionId:string;requestId:string;callId:string;action:CallControlAction}
/** update and claim must be atomic across all writers; claim persists before dispatch. */
export interface CallControlJournal {
    get<T>(key:string):Promise<T|undefined>;
    update<T>(key:string,change:(previous:T|undefined)=>T):Promise<T>;
    claim(key:string):Promise<boolean>;
}
export interface DurableCallControlPorts {
    calls:{list(query:{sessionId:string;branchId:string}):Promise<IndependentCallView[]>};
    callControl?(command:string,request:IndependentCallStateControlRequest):Promise<IndependentCallStateControlReceipt>;
    callCancel?(command:string,request:IndependentCallCancelRequest):Promise<IndependentCallCancellationReceipt|IndependentCallTreeCancellationReceipt>;
    log?(event:{operationId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number;outcome?:CallControlOutcome}):void;
}
export class CallControlError extends Error {constructor(readonly code:string){super(code);this.name='CallControlError';}}
export function assertCallControl(value:unknown,code:string):asserts value {if(!value)throw new CallControlError(code);}

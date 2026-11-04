import {IndependentCallCommand,type IndependentCallStateControlRequest,type IndependentCallStateControlReceipt} from '@nestos/llm-session/contracts';
import type {IndependentCallService} from '@nestos/llm-session';
import type {KanbanBoard,KanbanService,KanbanTaskControl} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from './automation-journal';
import {journalCommand} from './journal-command';
import {requireValue} from './validation';

export interface TaskControlPorts {
    calls:Pick<IndependentCallService,'list'>;
    callControl?(command:string,request:IndependentCallStateControlRequest):Promise<IndependentCallStateControlReceipt>;
}
interface ControlRecord {phase:'prepared'|'submitting';query:IndependentCallStateControlRequest}
type Observation=Pick<KanbanTaskControl,'state'|'code'>;
/** Freeze the original call route and epoch before control; lost responses are inspected, never resubmitted. */
export async function scanTaskControls(options:TaskControlPorts,journal:KanbanAutomationJournal,board:KanbanBoard,service:KanbanService):Promise<void> {
    for(const item of board.items) {
        const control=item.control;if(!control||['failed','paused','resumed'].includes(control.state))continue;
        let result:Observation;
        try {result=control.dispatchId?await observeControl(options,journal,board.id,control):{state:control.action==='pause'?'paused':'resumed'};}
        catch(error){result=controlFailure(error);}
        if(result.state===control.state&&result.code===control.code)continue;
        await journalCommand(journal,service,board.id,'task-control-projection:'+control.id+':'+result.state+':'+(result.code??''),
            {type:'control-receipt',itemId:item.id,controlId:control.id,...result});
    }
}
async function observeControl(options:TaskControlPorts,journal:KanbanAutomationJournal,boardId:string,control:KanbanTaskControl):Promise<Observation> {
    requireValue(options.callControl,'TASK_CONTROL_UNSUPPORTED');
    const key='task-control:'+boardId+':'+control.id;
    let record=await journal.get<ControlRecord>(key);
    if(!record){const prepared=await prepareControl(options,control);record=await journal.update<ControlRecord>(key,old=>old??prepared);}
    const submit=await journal.claim(key),{expectedEpoch:_epoch,...query}=record.query;
    const result=await options.callControl(submit?IndependentCallCommand.Control:IndependentCallCommand.ControlReceipt,(submit?record.query:query) as IndependentCallStateControlRequest);
    if(!result.receipt)return {state:'unknown',code:'TASK_CONTROL_RECEIPT_MISSING'};
    const current=result.receipt.current;
    return {state:current?.requestId===control.id&&current.acknowledged?control.action==='pause'?'paused':'resumed':'accepted'};
}
async function prepareControl(options:TaskControlPorts,control:KanbanTaskControl):Promise<ControlRecord> {
    const views=await options.calls.list({sessionId:control.dispatchId!,branchId:'main'}),view=views.find(v=>v.input.request.submission?.id===control.dispatchId);
    const capability=view?.controlCapabilities,state=view?.executionState;
    const withdraw=control.action==='resume'&&state?.control?.requested==='pause'&&!state.control.acknowledged;
    const supported=withdraw?capability?.withdrawPause:control.action==='pause'?capability?.pause==='boundary':capability?.resume;
    requireValue(supported,'TASK_CONTROL_UNSUPPORTED');requireValue(state&&view?.receipt.executionSessionId,'TASK_CONTROL_ROUTE_MISSING');
    return {phase:'prepared',query:{sessionId:control.dispatchId!,branchId:'main',callId:control.dispatchId!,executionSessionId:view.receipt.executionSessionId,
        taskId:state.id,requestId:control.id,action:withdraw?'withdraw':control.action,expectedEpoch:state.controlEpoch}};
}
function controlFailure(error:unknown):Observation {
    const raw=(error as {code?:unknown})?.code,code=typeof raw==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'TASK_CONTROL_UNKNOWN';
    return {state:['TASK_CONTROL_UNSUPPORTED','TASK_CONTROL_ROUTE_MISSING','CALL_READ_ONLY','CONTROL_EPOCH_CONFLICT'].includes(code)?'failed':'unknown',code};
}

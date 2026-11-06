import {sha256HexSync} from '@nestos/common';
import type {KanbanBoard,KanbanItem,KanbanItemOperationRequest,KanbanItemOperations,KanbanService,KanbanWorkflowState} from '@nestos/kanban/contracts';
import {safeCode,type KanbanAutomationJournal} from '@nestos/kanban/integration';
interface State {id:string;boardId:string;itemId:string;executionId:string;step:number;code?:string;done?:boolean;resolvedBy?:string;requests:Record<string,KanbanItemOperationRequest>}
interface Options {service:KanbanService;journal:KanbanAutomationJournal;active():boolean;
    automatic?(board:KanbanBoard,item:KanbanItem):Promise<boolean>;cleanup?(board:string,item:string,id:string):Promise<boolean>;
    view(board:string,item:string):Promise<KanbanItemOperations>;run(board:string,request:KanbanItemOperationRequest):Promise<KanbanItemOperations>;
    report?(state:State):Promise<void>}
const steps=['build','deploy','accept','analyze','merge','cleanup'];
const key=(board:string,item:string)=>'automatic-delivery:'+JSON.stringify([board,item]);
/** Frozen identities survive restart; unknown effects are observed rather than retried. */
export function automaticDelivery(options:Options) {
    return {ready:async(boardId:string,item:KanbanItem)=>{
        if(!options.automatic||!await options.automatic(await options.service.read(boardId),item))return true;
        return (await options.journal.get<State>(key(boardId,item.id)))?.done===true;
    },scan:async()=>{
        if(!options.automatic)return;
        for(const entry of await options.service.catalog()) {
            if(!options.active())return;
            await scanBoard(options,await options.service.read(entry.id));
        }
    }};
}
async function scanBoard(options:Options,board:KanbanBoard) {
    if(!board.automation?.enabled||board.executionControl?.paused||board.lifecycle)return;
    const workflow=await options.service.workflow(board.id);
    for(const item of board.items) {
        if(!options.active())return;
        if(item.deletedAt||item.control?.action==='cancel'||!['review','completed'].includes(item.status))continue;
        if(await options.automatic!(board,item))await scanItem(options,board,item,workflow);
    }
}
async function prepareState(options:Options,board:KanbanBoard,item:KanbanItem,workflow:KanbanWorkflowState) {
    const group=item.planning?.execution==='children';if(group&&item.status!=='completed')return;
    const dispatch=Object.values(workflow.dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt)[0];
    if(!group&&(!dispatch||!['succeeded','accepted'].includes(dispatch.outcome)))return;
    const id='auto-'+sha256HexSync(JSON.stringify([board.id,item.id,dispatch?.id??item.externalRefs?.find(ref=>ref.system==='nestos-decision-run')?.id])).slice(0,48);
    return options.journal.update<State>(key(board.id,item.id),old=>old??{id,boardId:board.id,itemId:item.id,executionId:dispatch?.id??item.id,step:group?5:0,requests:{}});
}
async function scanItem(options:Options,board:KanbanBoard,item:KanbanItem,workflow:KanbanWorkflowState) {
    let state=await prepareState(options,board,item,workflow);if(!state||state.done)return;
    try {
        if(state.code){state=await resumeConfirmedMerge(options,state);if(state.code)return;}
        await advance(options,state);
    }catch(error){
        if(!options.active())return;
        state=await options.journal.update<State>(key(board.id,item.id),old=>({...old!,code:safeCode(error,'AUTOMATIC_DELIVERY_FAILED')}));
        await options.report?.(state);
    }
}
async function resumeConfirmedMerge(options:Options,state:State):Promise<State> {
    if(state.code!=='OPERATION_SELECTION_REQUIRED')return state;
    const merge=(await options.view(state.boardId,state.itemId)).operations.find(row=>row.id==='merge');
    if(merge?.state!=='succeeded'||!merge.runId)return state;
    return options.journal.update<State>(key(state.boardId,state.itemId),old=>({...old!,code:undefined,step:5,resolvedBy:merge.runId}));
}
async function advance(options:Options,state:State) {
    const storageKey=key(state.boardId,state.itemId),action=steps[state.step];if(!options.active())return;
    if(action==='cleanup') {
        if(!options.cleanup||!await options.cleanup(state.boardId,state.itemId,state.id))return;
        const done=await options.journal.update<State>(storageKey,old=>({...old!,done:true,step:steps.length}));await options.report?.(done);return;
    }
    const view=await options.view(state.boardId,state.itemId);if(!options.active())return;
    const id=state.id+'-'+action,entry=view.operations.find(row=>row.id===action);
    if(entry?.runId===id) {
        if(entry.state==='failed')throw Object.assign(new Error('Automatic step failed'),{code:entry.code??'AUTOMATIC_STEP_FAILED'});
        if(entry.state!=='succeeded')return;
        await options.journal.update<State>(storageKey,old=>({...old!,step:old!.step+1}));return;
    }
    if(!entry?.enabled)return;
    if(action==='merge'&&entry.fields?.length)throw Object.assign(new Error('Conflict selection required'),{code:'OPERATION_SELECTION_REQUIRED'});
    const request=state.requests[action]??{operationId:id,itemId:state.itemId,action,expectedRevision:view.revision,confirmed:true,selections:{}};
    state=await options.journal.update<State>(storageKey,old=>({...old!,requests:{...old!.requests,[action]:old!.requests[action]??request}}));
    if(options.active())await options.run(state.boardId,state.requests[action]);
}
export async function automaticDeliveryStatus(journal:KanbanAutomationJournal,board:string,item:string):Promise<NonNullable<KanbanItemOperations['automatic']>|undefined> {
    const state=await journal.get<State>(key(board,item));
    return state?{state:state.done?'completed':state.code?'blocked':'running',stage:steps[state.step]??'completed',code:state.code}:undefined;
}

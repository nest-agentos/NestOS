import {currentAnalysis,KanbanCollaboration} from '@nestos/kanban/integration';
import type {Options} from './task-fix-contracts';
import type {SavedFix} from '@nestos/kanban/integration';
import {workContext} from './work-context';
import {requireValue} from './validation';
/** The host selects authorized resources; the library freezes identities and preparation. */
export async function freezeFix(options:Options,boardId:string,request:{itemId:string;operationId:string}):Promise<SavedFix> {
    const state=new KanbanCollaboration(options.service,options.journal);
    return state.prepareFix(boardId,request,async({id,board,item})=>{
        const refs=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
        requireValue((item.planning?.execution==='children'?refs.length>0:refs.length===1)&&options.automation.sessionChannel,'SINGLE_PROJECT_TASK_REQUIRED');
        const context=await workContext(options.journal,board,item,options.service);
        const decision=context.decision?{...context.decision,record:await state.decisionSnapshot(context.decision)}:null;
        const parent=item.planning?.parentId?(await options.service.item(boardId,item.planning.parentId)).item:null;
        const origin=await fixOrigin(options,boardId,item);
        return {origin,resourceId:item.planning?.execution==='children'&&context.primaryProjectId?context.primaryProjectId:refs[0].id,context:{...context,parent,task:structuredClone(item),decision,fix:{id,originalOperationId:origin.id,scopeId:id}}};
    });
}

async function fixOrigin(options:Options,boardId:string,item:import('@nestos/kanban/contracts').KanbanItem) {
    if(item.planning?.execution==='children') {
        const analysis=await currentAnalysis<import('@nestos/llm-session/contracts').IndependentCallInput>(options.journal,boardId,item.id);
        requireValue(analysis?.input,'COORDINATION_SESSION_UNAVAILABLE');
        return {id:analysis.id,input:analysis.input};
    }
    const dispatches=Object.values((await options.service.workflow(boardId)).dispatches).filter(row=>row.itemId===item.id).sort((a,b)=>b.attempt-a.attempt);
    for(const dispatch of dispatches) {
        const call=(await options.automation.calls.list({sessionId:dispatch.id})).find(call=>call.input.request.submission?.id===dispatch.id);
        if(call)return {id:dispatch.id,input:call.input};
    }
    throw Object.assign(new Error('CONTINUATION_SESSION_UNKNOWN'),{code:'CONTINUATION_SESSION_UNKNOWN'});
}

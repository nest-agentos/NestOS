import {KanbanCollaboration} from '@nestos/kanban/integration';
import type {Options} from './task-fix-contracts';
import type {SavedFix} from '@nestos/kanban/integration';
import {workContext} from './work-context';
import {requireValue} from './validation';
/** The host selects authorized resources; the library freezes identities and preparation. */
export async function freezeFix(options:Options,boardId:string,request:{itemId:string;operationId:string}):Promise<SavedFix> {
    const state=new KanbanCollaboration(options.service,options.journal);
    return state.prepareFix(boardId,request,async({id,board,item})=>{
        const refs=item.externalRefs?.filter(ref=>ref.system==='nestos-remote-project')??[];
        requireValue(refs.length===1&&options.automation.sessionChannel,'SINGLE_PROJECT_TASK_REQUIRED');
        const context=await workContext(options.journal,board,item);
        const decision=context.decision?{...context.decision,record:await state.decisionSnapshot(context.decision)}:null;
        const parent=item.planning?.parentId?(await options.service.item(boardId,item.planning.parentId)).item:null;
        return {resourceId:refs[0].id,context:{...context,parent,task:structuredClone(item),decision,fix:{id,sourceSessionId:id,scopeId:id}}};
    });
}

import {KanbanCollaboration,createTaskFix as createFixRuntime} from '@nestos/kanban/integration';
import type {KanbanDispatch} from '@nestos/kanban/contracts';
import type {SessionInstruction} from '@nestos/llm-session/contracts';
import type {Options} from './task-fix-contracts';
import {createPublishedKanbanWorkExecutor} from './published-work';
import {automationTarget} from './automation-targets';
import {acceptSnapshot} from './task-fix-acceptance';
import {observeFixMessages} from './task-fix-messages';
import {confirmFix} from './task-fix-confirmation';
import {freezeFix} from './task-fix-preparation';
import {kanbanControlOptions} from './control-adapter';
import {requireValue} from './validation';
export function createTaskFix(options:Options) {
    const binding=async(dispatch:KanbanDispatch)=>{
        const fix=await new KanbanCollaboration(options.service,options.journal).fix(dispatch.id);
        const board=await options.service.read(fix.boardId);
        requireValue(board.automation?.preparation&&options.automation.prepareWork,'FIX_PREPARATION_UNAVAILABLE');
        const prepared=await options.automation.prepareWork({stage:'fix',context:fix.context,dispatch,item:fix.item,
            target:automationTarget(board.automation.executor,await options.automation.catalog()),preparation:board.automation.preparation,options:board.automation.preparationOptions});
        requireValue(prepared.contextRef,'FIX_CHANNEL_REQUIRED');
        return prepared;
    };
    const primary=createPublishedKanbanWorkExecutor({...options.automation,prepareSession:options.prepareSession,binding});
    const executor={...primary,prepare:(dispatch:KanbanDispatch,item:import('@nestos/kanban/contracts').KanbanItem)=>primary.prepare(dispatch,
        {...item,responsibility:'Clarify a new fix task. Read task-fix-pre.md and context sections through session_context. Do not develop or rerun the original task.'})};
    return createFixRuntime<SessionInstruction>({service:options.service,journal:options.journal,executor,
        control:kanbanControlOptions(options.automation,options.journal).control,
        freeze:(board,request)=>freezeFix(options,board,request),confirm:(fix,input)=>confirmFix(options,fix,input),
        observe:fix=>observeFixMessages(options,fix),accept:fix=>acceptSnapshot(options,fix),log:options.log});
}

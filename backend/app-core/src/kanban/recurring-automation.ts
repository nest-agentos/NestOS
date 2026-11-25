import type {KanbanBoard} from '@nestos/kanban/contracts';
import {automationCatalog,automationTarget,developmentCatalog} from '@nestos/kanban-development';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {requireValue} from './validation';

export function recurringAutomation(options:PersonalKanbanAutomationOptions) {
    return async (board:KanbanBoard):Promise<NonNullable<KanbanBoard['automation']>>=>{
        const published=await options.catalog();
        if(board.automation){
            automationTarget(board.automation.planner,published);
            automationTarget(board.automation.executor,published);
            return {...board.automation,enabled:true,autoAccept:false};
        }
        const {targets,coordinator,worker}=automationCatalog(published);
        const planner=targets.find(({reference})=>reference.system==='nestos-published-agent'&&reference.id==='kanban-file-planner')?.reference;
        const executor=targets.find(({reference})=>reference.system==='nestos-published-agent'&&reference.id==='kanban-development-worker')?.reference;
        const preparation=options.preparations?.find(({reference})=>reference.id===developmentCatalog()[0].reference.id)?.reference;
        requireValue(planner&&executor&&preparation&&options.prepareWork&&options.prepareAnalysis,'RECURRENCE_AUTOMATION_TARGET_UNAVAILABLE');
        return {enabled:true,autoAccept:false,planner,executor,coordinator,worker,preparation,preparationOptions:{commit:'changes'}};
    };
}

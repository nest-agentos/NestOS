import type {KanbanBoard,KanbanProjectRecord} from '@nestos/kanban/contracts';
import {automationCatalog,automationTarget,developmentCatalog} from '@nestos/kanban-development';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import {projectDirectoryPreparation} from '../presets/kanban-project-directory';
import {usesSoftwareModule} from './decision-modules';
import {requireValue} from './validation';

export function recurringAutomation(options:PersonalKanbanAutomationOptions) {
    return async (board:KanbanBoard,record:KanbanProjectRecord):Promise<NonNullable<KanbanBoard['automation']>>=>{
        const published=await options.catalog();
        const software=usesSoftwareModule(record);
        if(software&&board.automation?.preparation?.id==='git-worktree'){
            automationTarget(board.automation.planner,published);
            automationTarget(board.automation.executor,published);
            return {...board.automation,enabled:true,autoAccept:false};
        }
        const {targets,coordinator,worker}=automationCatalog(published);
        const planner=targets.find(({reference})=>reference.system==='nestos-published-agent'&&reference.id==='kanban-file-planner')?.reference;
        const executor=targets.find(({reference})=>reference.system==='nestos-published-agent'&&reference.id==='kanban-development-worker')?.reference;
        const preparation=software?options.preparations?.find(({reference})=>reference.id===developmentCatalog()[0].reference.id)?.reference:projectDirectoryPreparation;
        requireValue(planner&&executor&&preparation&&options.prepareWork&&options.prepareAnalysis,'RECURRENCE_AUTOMATION_TARGET_UNAVAILABLE');
        return {enabled:true,autoAccept:false,planner,executor,coordinator,worker,preparation,...(software?{preparationOptions:{commit:'changes'}}:{})};
    };
}

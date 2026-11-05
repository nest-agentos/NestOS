import type {KanbanClient} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {UserEventService} from '../events/service';
export interface Options {service:KanbanClient; journal:KanbanAutomationJournal; events:UserEventService;
    automation:PersonalKanbanAutomationOptions;
    log(input:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}

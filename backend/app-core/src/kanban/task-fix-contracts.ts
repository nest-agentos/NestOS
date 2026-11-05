import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanClient} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {UserEventService} from '../events/service';
export interface Options {fs:IFileSystem; service:KanbanClient; journal:KanbanAutomationJournal; events:UserEventService;
    automation:PersonalKanbanAutomationOptions; prepareSession(id:string):Promise<string>;
    log(input:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}

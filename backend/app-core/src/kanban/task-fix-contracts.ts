import type {IFileSystem} from '@nestos/vfs-core';
import type {KanbanClient, KanbanItem, KanbanDispatch, KanbanFixSession} from '@nestos/kanban/contracts';
import type {PersonalKanbanAutomationOptions} from './personal-automation';
import type {KanbanAutomationJournal} from './automation-journal';
import type {UserEventService} from '../events/service';
export interface Definition {title:string; responsibility:string; acceptance:string; type:'fix'; dependencies:string[]}
export interface Snapshot {messageId:string; content:'完成'; definition:Definition; digest:string; operationId:string}
export interface SavedFix extends KanbanFixSession {
    phase:'prepared'|'submitting'; dispatch:KanbanDispatch; item:KanbanItem; projectId:string; context:unknown; request:unknown;
    snapshot?:Snapshot; code?:string; accepted?:boolean;
}
export interface Options {fs:IFileSystem; service:KanbanClient; journal:KanbanAutomationJournal; events:UserEventService;
    automation:PersonalKanbanAutomationOptions; prepareSession(id:string):Promise<string>;
    log(input:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void}

import type {IFileSystem} from '@nestos/vfs-core';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {KanbanClient} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal,SavedRecordConversation} from '@nestos/kanban/integration';
export interface DecisionConversationOptions {
    active?():boolean;fs:IFileSystem;projects:Pick<ProjectService,'list'|'get'|'openWorkspace'>;remote:ProjectRemoteMountService;
    journal:KanbanAutomationJournal;service:KanbanClient;client():KanbanClient;
    executionResource?(id:string,branch:string,board?:import('@nestos/kanban/contracts').KanbanBoard):Promise<string|undefined>;
    log(event:{operationId:string;boardId:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}
export interface DecisionConversationBinding {id:string;boardId:string;purpose?:'coordination';recordId?:string;projectId:string;projectIds?:string[];profileId:string;workspaceId:string;directory:string;epoch:string;createId:string;inputId:string}
export type DecisionConversation = SavedRecordConversation & {binding:DecisionConversationBinding};

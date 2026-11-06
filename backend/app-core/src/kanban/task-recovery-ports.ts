import type {KanbanClient,KanbanTaskRecoveryRequest,KanbanTaskRecoveryResult} from '@nestos/kanban/contracts';
import type {KanbanAutomationJournal} from '@nestos/kanban/integration';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {RuntimeServiceDescriptor} from '../runtime/service-control';
import type {ChannelResponse} from '../run/channel-protocol';
export interface TaskRecoveryOptions {
    fs:import('@nestos/vfs-core').IFileSystem;service:KanbanClient;client():KanbanClient;journal:KanbanAutomationJournal;remote:ProjectRemoteMountService;
    projects:Pick<ProjectService,'get'>;describe(item:import('@nestos/kanban/contracts').KanbanItem):Promise<RuntimeServiceDescriptor|undefined>;
    executionResource(id:string,branch:string,board?:import('@nestos/kanban/contracts').KanbanBoard):Promise<string|undefined>;
    log(event:{operationId:string;boardId?:string;stage:string;result:'success'|'failure';code?:string;durationMs:number}):void;
}
export interface RecoverySession {boardId:string;itemId:string;dispatchId:string;scopeId:string;projectId:string;profileId:string;sessionId:string;resourceId:string;ready?:boolean}
export interface RecoveryIntent {boardId:string;request:KanbanTaskRecoveryRequest;digest:string;dispatchId:string;previousDispatchId:string;targetVersion?:string;done?:boolean;result?:KanbanTaskRecoveryResult;evidence?:{version:string;serviceId:string;previous:unknown;approval?:string;sourceOperationId?:string;sourceItemId?:string};command?:import('@nestos/kanban/contracts').KanbanCommand}
export interface RecoveryReply {requestDigest:string;response:ChannelResponse;resumed?:boolean}

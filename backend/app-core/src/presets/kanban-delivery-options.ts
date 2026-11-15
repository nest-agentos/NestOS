import type {KanbanService,KanbanProjectRecord} from '@nestos/kanban/contracts';
import type {DevelopmentWorkspaceRecord} from './kanban-development';
/** Apply explicit delivery amendments to newly prepared operations, never overwrite saved operation records. */
export async function currentDeliveryRecord(service:Pick<KanbanService,'record'>,record:DevelopmentWorkspaceRecord):Promise<DevelopmentWorkspaceRecord> {
    const context=record.context as {decision?:{sourceBoardId:string;recordId:string;snapshot?:KanbanProjectRecord}}|undefined;
    if(!context?.decision)return record;
    const current=await service.record(context.decision.sourceBoardId,context.decision.recordId);
    if(!current.deliveryOptions)return record;
    return {...record,context:{...context,decision:{...context.decision,snapshot:{...context.decision.snapshot,deliveryOptions:current.deliveryOptions}}}};
}

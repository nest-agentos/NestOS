import type {KanbanOperationPlugin,KanbanOperationProvider,KanbanOperationPluginContext} from '@nestos/kanban/integration';
import {t} from '@nestos/common';
/** Business actions live here; Kanban only owns provider routing and durable coordination. */
export function createSoftwareDevelopmentPlugin(create:(context:KanbanOperationPluginContext)=>KanbanOperationProvider):KanbanOperationPlugin {
    return {id:'software-development',version:'1',label:t('kanban.softwareDevelopmentPlugin'),
        actions:['build','deploy','accept','analyze','merge','cleanup'].map(id=>({id,coordination:id!=='cleanup',label:t(('kanban.operationAction.'+id) as Parameters<typeof t>[0])})),create};
}

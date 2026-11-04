import {createKanbanActivityModule, type KanbanActivityModuleOptions} from '@nestos/kanban/activity';
import {KanbanError} from '@nestos/kanban';
import type {KanbanNotifications} from './notifications';
import {projectKanbanEvents} from './notifications';
import {createKanbanExecutionBridge, type KanbanExecutionBridgeOptions} from '@nestos/kanban/execution';
import {KANBAN_EXECUTION_SESSION, executionSessionReference} from '@nestos/app-contracts';

export interface NestOSKanbanOptions extends Omit<KanbanActivityModuleOptions, 'referenceSystem' | 'onCommitted'> {onCommitted?: KanbanActivityModuleOptions['onCommitted']; notifications?: KanbanNotifications}

/** NestOS supplies its resource namespace, authorized catalog and system event projection. */
export function createNestOSKanban(options: NestOSKanbanOptions) {
    if ((!options.actor.kind || options.actor.kind === 'agent') && (!options.actor.sessionId || !options.actor.taskId)) throw new KanbanError('INVALID_ID');
    const {notifications, onCommitted, ...core} = options;
    return createKanbanActivityModule({...core, referenceSystem: KANBAN_EXECUTION_SESSION,
        onCommitted: notifications || onCommitted ? async (boardId, service, now) => {
            const results = await Promise.allSettled([notifications ? projectKanbanEvents(notifications, service, boardId, now) : undefined, onCommitted?.(boardId, service, now)]);
            const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (errors.length) throw new AggregateError(errors.map(result => result.reason), 'KANBAN_PROJECTION_FAILED');
        } : undefined,
    });
}

export function createNestOSKanbanExecutionBridge(options: KanbanExecutionBridgeOptions) {
    return createKanbanExecutionBridge({...options, executionReference: executionSessionReference});
}

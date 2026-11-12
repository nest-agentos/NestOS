import {KanbanError} from '@nestos/kanban';

export function requireValue(condition: unknown, code: string): asserts condition {
    if (!condition) throw new KanbanError(code);
}

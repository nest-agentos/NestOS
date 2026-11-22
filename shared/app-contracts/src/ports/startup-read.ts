import type {EventCursor} from '@nestos/vfs-core';
import type {KanbanDecisionQuery,KanbanDecisionSnapshot,KanbanTaskSnapshot,KanbanTaskSnapshotOptions} from '@nestos/kanban/contracts';
export interface StartupReadRequest {
    documents?: string[];
    eventBaseline?: boolean;
    task?: {boardId:string;itemId:string}&KanbanTaskSnapshotOptions;
    decision?: {boardId:string;query:KanbanDecisionQuery};
}
export type StartupReadSection<T>={value:T;code?:never}|{value?:never;code:string};
/** A single-use route response, not a cross-request cache or a command receipt. */
export interface StartupReadResult {
    request:StartupReadRequest;
    documents?:StartupReadSection<Record<string,unknown>>;
    eventBaseline?:StartupReadSection<EventCursor>;
    unreadNotifications?:StartupReadSection<number>;
    task?:StartupReadSection<KanbanTaskSnapshot>;
    decision?:StartupReadSection<KanbanDecisionSnapshot>;
}

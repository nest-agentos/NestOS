import type { EventCursor, JournalEvent, JournalPage } from '@nestos/vfs-core';

/** No message bodies, tool parameters or credentials belong in application event payloads. */
export interface ApplicationEventFact {
    type: string;
    resourceId?: string;
    operationId?: string;
    sourceSequence?: number;
    notification?: 'info' | 'error';
}
export interface ApplicationEventPage extends JournalPage<ApplicationEventFact> {
    unreadNotifications?: number;
}
export interface ApplicationEvents {
    eventBaseline(): Promise<EventCursor>;
    notificationSummary?():Promise<{head:EventCursor;unread:number}>;
    readEvents(after?: EventCursor, limit?: number, includeNotifications?: true): Promise<ApplicationEventPage>;
    listNotifications(limit?: number): Promise<{items: Array<{event: JournalEvent<ApplicationEventFact>; read: boolean}>; head: EventCursor}>;
    setNotificationRead(eventId: string, read: boolean): Promise<void>;
    /** A hint only. Each browser keeps its own replay cursor; this never acknowledges delivery. */
    onChange(listener: () => void): () => void;
}

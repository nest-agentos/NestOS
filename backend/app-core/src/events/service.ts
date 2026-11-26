import {randomUUID} from '@nestos/common';
import {FSError, SeqEventJournal, type IFileSystem, type EventCursor} from '@nestos/vfs-core';
import type {ApplicationEvents, ApplicationEventFact} from '@nestos/app-contracts/services';
import {decodeRead,initializeNotificationIndex,markNotification,notificationSummary,projectNotification,readKey,retainedEvents} from './notification-index';

/** One instance per authenticated runtime. Publication is host-only, never an RPC method. */
export class UserEventService implements ApplicationEvents {
    private constructor(readonly journal: SeqEventJournal<ApplicationEventFact>) {}
    static async open(fs: IFileSystem): Promise<UserEventService> {
        const journal=await SeqEventJournal.open(fs,'/var/lib/events/events.seq',randomUUID(),1000,projectNotification);
        await journal.transaction(initializeNotificationIndex);
        return new UserEventService(journal);
    }
    eventBaseline() {return this.journal.baseline();}
    notificationSummary() {return this.journal.transaction(notificationSummary);}
    readEvents(after?: EventCursor, limit?: number, includeNotifications?: true) {
        if (includeNotifications !== true) return this.journal.read(after, limit);
        return this.journal.transaction(async tx => ({...await tx.read(after, limit),
            unreadNotifications: (await notificationSummary(tx)).unread}));
    }
    onChange(listener: () => void) {return this.journal.onChange(listener);}
    async listNotifications(limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new FSError('EINVAL', 'Invalid notification limit');
        return this.journal.transaction(async tx=>{
            const events=await retainedEvents(tx),states=new Set(decodeRead(await tx.getState(readKey)));
            return {items:events.filter(event=>event.value.notification).slice(-limit).reverse()
                .map(event=>({event,read:states.has(event.id)})),head:tx.baseline()};
        });
    }
    async setNotificationRead(eventId: string, read: boolean): Promise<void> {
        if (typeof eventId !== 'string' || eventId.length > 512 || typeof read !== 'boolean') throw new FSError('EINVAL', 'Invalid notification state');
        await this.journal.transaction(tx=>markNotification(tx,eventId,read));
    }
}

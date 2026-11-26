import type {ApplicationEvents, ApplicationEventFact} from '@nestos/app-contracts/services';
import type {EventCursor, JournalEvent} from '@nestos/vfs-core';

export interface EventFeedHandlers {
    notificationCount?(unread: number): void;
    receiveBatch?(events: readonly JournalEvent<ApplicationEventFact>[]):void|Promise<void>;
    receive(event: JournalEvent<ApplicationEventFact>): void | Promise<void>;
    /** Reload domain snapshots; called when retention or a new storage incarnation invalidates the cursor. */
    reset(): void | Promise<void>;
    failure(error: unknown): void;
}

interface EventHintPolicy {delayMs: number; visible(): boolean}

/** One instance per browser/view. It never marks notifications read or acknowledges other consumers. */
export class ApplicationEventFeed {
    private cursor: EventCursor;
    private stop?: () => void;
    private pending?: Promise<void>;
    private hintTimer?: ReturnType<typeof setTimeout>;
    private dirty = false;
    private closed = false;
    constructor(private readonly source: ApplicationEvents, after: EventCursor, private readonly handlers: EventFeedHandlers,
        private readonly hints?: EventHintPolicy) {
        this.cursor = {...after};
    }
    async start(): Promise<void> {
        if (this.closed || this.stop) return;
        const stop=this.source.onChange(() => this.onHint()) as (()=>void)&{ready?:Promise<void>};
        this.stop=stop;
        try {await stop.ready;await this.refresh();} catch (error) {this.close(); throw error;}
    }
    getCursor(): EventCursor {return {...this.cursor};}
    close(): void {this.closed = true; this.clearHint(); this.stop?.(); this.stop = undefined;}
    refresh(): Promise<void> {
        if (this.closed) return Promise.resolve();
        this.clearHint();
        this.dirty = true;
        return this.pending ??= this.drain().finally(() => {
            this.pending = undefined;
            if (this.dirty && !this.closed && this.canRead()) void this.refresh().catch(error => this.handlers.failure(error));
        });
    }
    private onHint(): void {
        if (this.closed || this.hintTimer !== undefined || !this.canRead()) return;
        const read = () => {
            this.hintTimer = undefined;
            if (this.canRead()) void this.refresh().catch(error => this.handlers.failure(error));
        };
        if (this.hints) this.hintTimer = setTimeout(read, this.hints.delayMs);
        else read();
    }
    private clearHint(): void {
        clearTimeout(this.hintTimer); this.hintTimer = undefined;
    }
    private canRead(): boolean {return this.hints?.visible() ?? true;}
    private async drain(): Promise<void> {
        while (this.dirty && !this.closed && this.canRead()) {
            this.dirty = false;
            let page;
            try {page = this.handlers.notificationCount ? await this.source.readEvents(this.cursor, undefined, true)
                : await this.source.readEvents(this.cursor);}
            catch (error) {
                if ((error as {code?: string}).code !== 'ECONFLICT') throw error;
                const baseline = await this.source.eventBaseline();
                await this.handlers.reset();
                if (this.closed) return;
                this.cursor = baseline; this.dirty = true; continue;
            }
            await this.deliverPage(page.events,page.cursor.streamId);
            if (!this.closed && page.unreadNotifications !== undefined) this.handlers.notificationCount?.(page.unreadNotifications);
            this.dirty ||= page.more;
        }
    }
    private async deliverPage(events:JournalEvent<ApplicationEventFact>[],streamId:string):Promise<void> {
        let batch:JournalEvent<ApplicationEventFact>[]=[];
        for(const event of events) {
            if(this.closed)return;
            if(event.value.type==='runtime.reset'||event.value.type==='source.reset') {
                await this.deliverBatch(batch,streamId);batch=[];if(this.closed)return;
                await this.handlers.reset();if(this.closed)return;
                await this.handlers.receive(event);if(this.closed)return;
                this.cursor={streamId,sequence:event.sequence};
            }else batch.push(event);
        }
        await this.deliverBatch(batch,streamId);
    }
    private async deliverBatch(events:JournalEvent<ApplicationEventFact>[],streamId:string):Promise<void> {
        if(this.closed||!events.length)return;
        if(this.handlers.receiveBatch) {
            await this.handlers.receiveBatch(events);if(this.closed)return;
            this.cursor={streamId,sequence:events[events.length-1].sequence};return;
        }
        for(const event of events) {
            if(this.closed)return;
            await this.handlers.receive(event);if(this.closed)return;
            this.cursor={streamId,sequence:event.sequence};
        }
    }

}

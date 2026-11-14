import {randomUUID} from '@nestos/common';
import {bindViewSources, overlay as delegate} from '../lifecycle/view-sources';
import type {ApplicationServices, ApplicationViewEvent, ApplicationViewSources, ConversationWorkbenchView, PreparedConversation, WorkbenchNavigationView} from '@nestos/app-contracts/services';
import type {IFileSystem} from '@nestos/vfs-core';

/** Adapt one owned view observation to existing UI ports without extra remote listeners. */
export class WorkbenchSources {
    private readonly listeners = new Map<keyof ApplicationViewSources, Set<(value: any) => void>>();
    private readonly statuses = new Map<string, WorkbenchNavigationView['statuses'][string]>();
    private stop?: () => void;
    private closed = false;
    private cursor: number;
    private recovering?: Promise<void>;
    constructor(readonly opening: ConversationWorkbenchView) {this.cursor = opening.cursor;}
    async start(): Promise<void> {
        const stop = await this.opening.subscribe(event => this.deliver(event), failure => this.recover(failure.code));
        if (this.closed) {stop(); return;}
        this.stop = stop;
        const snapshot = this.opening.eventSnapshot();
        if (this.cursor < snapshot.firstSequence - 1) this.recover('WORKBENCH_OBSERVATION_GAP');
        else for (const event of snapshot.events) this.deliver(event);
    }
    close(): void {this.closed = true; this.stop?.(); this.stop = undefined; this.listeners.clear(); this.statuses.clear();}
    private on<K extends keyof ApplicationViewSources>(topic: K, listener: (value: ApplicationViewSources[K]) => void): () => void {
        let listeners = this.listeners.get(topic);
        if (!listeners) this.listeners.set(topic, listeners = new Set());
        listeners.add(listener); return () => {listeners.delete(listener);};
    }
    private deliver(event: ApplicationViewEvent): void {
        if (this.closed) return;
        if (event.sequence > 0) {if (event.sequence <= this.cursor) return; this.cursor = event.sequence;}
        if (event.topic === 'remoteStatus') this.statuses.set(event.value.projectId, event.value.rows);
        for (const listener of [...(this.listeners.get(event.topic) ?? [])]) listener(event.value);
    }
    private recover(code: string): void {
        if (this.closed || this.recovering) return;
        const operationId = randomUUID(), started = performance.now();
        this.cursor = this.opening.eventSnapshot().cursor;
        console.warn('[Workbench observation]', {operation: 'workbench.observe', stage: 'reconcile', result: 'failure', code, operationId, durationMs: 0});
        this.recovering = this.opening.readNavigation({projectId: null}).then(view => {
            if (this.closed) return;
            this.navigation(view);
            for (const [projectId, rows] of Object.entries(view.statuses)) this.deliver({sequence: 0, topic: 'remoteStatus', value: {projectId, rows}});
            this.deliver({sequence: 0, topic: 'mounts', value: undefined});
            if (this.opening.native) this.deliver({sequence: 0, topic: 'conversation', value: {resourceId: this.opening.native.resourceId}});
        }).catch(error => {
            const raw = (error as {code?: unknown})?.code;
            const code = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(raw) ? raw : 'WORKBENCH_RECONCILE_FAILED';
            console.warn('[Workbench observation]', {operation: 'workbench.observe', operationId, stage: 'reconcile', result: 'failure', code, durationMs: Math.round(performance.now() - started)});
        })
            .finally(() => {this.recovering = undefined;});
    }
    services(source: ApplicationServices): ApplicationServices {
        const bound = bindViewSources(source, (topic, listener) => this.on(topic, listener));
        return {...bound, projects: this.projects(bound.projects)};
    }

    private projects(source: ApplicationServices['projects']): ApplicationServices['projects'] {
        const remote = source.remoteMounts, status = remote?.sessionStatus;
        const sessionStatus = status && delegate(status, {
            subscribe: (projectId, listener) => this.on('remoteStatus', event => {if (event.projectId === projectId) listener();}),
            records: projectId => this.statuses.get(projectId) ?? [],
            record: (projectId, profileId, sessionId) => this.statuses.get(projectId)?.find(row => row.profileId === profileId && row.sessionId === sessionId),
            get: (projectId, profileId, sessionId) => this.statuses.get(projectId)?.find(row => row.profileId === profileId && row.sessionId === sessionId)?.observation,
        });
        return delegate(source, {remoteMounts: remote && delegate(remote, {sessionStatus})});
    }
    files(source: IFileSystem): IFileSystem {
        return delegate(source, {onAny: listener => this.on('navigation', listener),
            on: (type, listener) => this.on('navigation', event => {if (event.type === type) listener(event as Parameters<typeof listener>[0]);})});
    }
    conversation(prepared: PreparedConversation): PreparedConversation {
        return {...prepared, conversation: delegate(prepared.conversation, {
            subscribe: listener => this.on('conversation', event => {if (event.resourceId === prepared.resourceId) listener();}),
        })};
    }
    navigation(view: WorkbenchNavigationView): WorkbenchNavigationView {
        for (const [projectId, rows] of Object.entries(view.statuses)) this.statuses.set(projectId, rows);
        return view;
    }
}

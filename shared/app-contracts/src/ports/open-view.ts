import type {ApplicationServices, ApplicationBackend} from './application-client';
import type {WorkbenchView, SessionEditorInitialData} from './session';

export interface OpenViewRequest {
    resourceId?: string;
    documents: string[];
    workbench: NonNullable<Parameters<ApplicationBackend['workbenchView']>[0]>;
    branch?: string;
    taskAttachmentKey?: string;
}
export interface ApplicationViewSources {
    repository: Parameters<Parameters<NonNullable<ApplicationServices['sessionRepository']['subscribe']>>[0]>[0];
    files: Parameters<Parameters<ApplicationServices['sessionFiles']['subscribe']>[0]>[0];
    favorites: undefined;
    kernel: Parameters<Parameters<ApplicationServices['kernel']['kernel']['onChanged']>[0]>[0];
    draft: Parameters<Parameters<ApplicationServices['projects']['drafts']['onPromoted']>[0]>[0];
    mounts: import('./projects').ProjectRemoteMountChange | undefined;
    navigation: import('@nestos/vfs-core').FSEvent;
    conversation: {resourceId: string};
    remoteStatus: {projectId: string; rows: readonly import('@nestos/cells-driver/harness').HarnessStatusRow[]};
    session: Parameters<Parameters<ApplicationServices['sessionManager']['onEvent']>[0]>[0];
    global: Parameters<Parameters<ApplicationServices['sessionManager']['onGlobalEvent']>[0]>[0];
    agents: undefined;
    configuration: undefined;
    skills: {sessionId: string};
}
export type ApplicationViewEvent = {[K in keyof ApplicationViewSources]: {
    sequence: number; topic: K; value: ApplicationViewSources[K];
}}[keyof ApplicationViewSources];
export interface ApplicationViewObservation {
    getViewCursor(): number;
    /** Synchronous read model and its cursor; consumers must not mutate the snapshot. */
    getSessionBaseline(): {cursor: number; snapshot: SessionEditorInitialData['snapshot']};
    observeView(after: number, listener: (event: ApplicationViewEvent) => void): Promise<() => void>;
    dispose(): Promise<void>;
}
export interface OpenedApplicationView {
    conversationWorkbench?: import('./conversation-workbench').ConversationWorkbenchView;
    connectionInterests?: string[];
    documents: Record<string, unknown>;
    workbench: WorkbenchView;
    initial?: SessionEditorInitialData;
    taskAttachmentKey?: string;
    observation: ApplicationViewObservation;
    cursor: number;
    dispose(): Promise<void>;
}

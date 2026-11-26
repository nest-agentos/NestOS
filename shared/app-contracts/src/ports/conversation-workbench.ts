import type {ProjectConversationPort, ProjectDraftComposer, ProjectFolder} from './projects';
import type {SessionDirectoryView, SessionOpenView, WorkbenchView} from './session';
import type {ApplicationViewEvent} from './open-view';

export interface ProjectDraftOpening {
    project: ProjectFolder;
    folder: string;
    composer: ProjectDraftComposer;
}

/** Fresh data prepared for one opening, never a reusable execution authorization. */
export interface PreparedConversation {
    resourceId: string;
    project: ProjectFolder;
    conversation: ProjectConversationPort;
    draft?: Awaited<ReturnType<NonNullable<ProjectConversationPort['readComposerDraft']>>>;
    models?: Awaited<ReturnType<NonNullable<ProjectConversationPort['models']>>>;
    commands?: Awaited<ReturnType<NonNullable<ProjectConversationPort['commands']>>>;
    deferredMetadata?: boolean;
    issues: Partial<Record<'models' | 'commands' | 'metrics', string>>;
}
export interface WorkbenchOpenRequest {
    resourceId: string;
    documents: string[];
    displayedFilesPolicy?: 'gitignore' | 'all';
}
export interface WorkbenchNavigationRequest {
    projectId?: string | null;
    resourceId?: string;
    expandedPaths?: string[];
    refresh?: boolean;
}
export interface WorkbenchNavigationView extends SessionDirectoryView {
    statuses: Record<string, readonly import('@nestos/cells-driver/harness').HarnessStatusRow[]>;
}
export interface WorkbenchRefreshRequest {
    navigation?: WorkbenchNavigationRequest;
    activity?: string[];
    sessionId?: string;
}
export interface WorkbenchRefreshView {
    navigation?: WorkbenchNavigationView;
    activity?: Record<string, import('@nestos/durable-kernel/contracts').SessionActivity | null>;
    session?: {id: string; manifest: Pick<import('@nestos/llm-session/contracts').ConversationManifest,
        'id' | 'currentBranch' | 'createdAt' | 'updatedAt'> | null};
}
/** Application composition owns observation and resources; command ports stay independent. */
export interface ResourceWorkbenchView {
    resourceId: string;
    documents: Record<string, unknown>;
    workbench: WorkbenchView;
    native?: PreparedConversation;
    draft?: ProjectDraftOpening;
    failure?: {resourceId: string; code: string; reason?: string};
    eventSnapshot(): {cursor: number; firstSequence: number; events: ApplicationViewEvent[]};
    subscribe(listener: (event: ApplicationViewEvent) => void, failed?: (failure: {code: string}) => void): Promise<() => void>;
    cursor: number;
    prepareChat(): Promise<NonNullable<WorkbenchView['chat']>>;
    openConversation(resourceId: string): Promise<PreparedConversation>;
    openSession?(sessionId: string): Promise<SessionOpenView>;
    prepareDraftSession?(draftId: string, request?: Parameters<ProjectDraftComposer['prepare']>[0]):
        Promise<Awaited<ReturnType<ProjectDraftComposer['prepare']>> & {view: SessionOpenView}>;
    readNavigation(request: WorkbenchNavigationRequest): Promise<WorkbenchNavigationView>;
    readRefresh?(request: WorkbenchRefreshRequest): Promise<WorkbenchRefreshView>;
    setVisible(visible: boolean): Promise<void>;
    dispose(): Promise<void>;
}

/** Compatibility names for existing conversation callers. */
export type ConversationWorkbenchRequest = WorkbenchOpenRequest;
export type ConversationWorkbenchView = ResourceWorkbenchView;

import type {ProjectConversationPort, ProjectFolder} from './projects';
import type {SessionDirectoryView, WorkbenchView} from './session';
import type {ApplicationViewEvent} from './open-view';

/** Fresh data prepared for one opening, never a reusable execution authorization. */
export interface PreparedConversation {
    resourceId: string;
    project: ProjectFolder;
    conversation: ProjectConversationPort;
    draft?: Awaited<ReturnType<NonNullable<ProjectConversationPort['readComposerDraft']>>>;
    models?: Awaited<ReturnType<NonNullable<ProjectConversationPort['models']>>>;
    commands?: Awaited<ReturnType<NonNullable<ProjectConversationPort['commands']>>>;
    issues: Partial<Record<'models' | 'commands' | 'metrics', string>>;
}
export interface ConversationWorkbenchRequest {
    resourceId: string;
    documents: string[];
    displayedFilesPolicy?: 'gitignore' | 'all';
}
export interface WorkbenchNavigationRequest {
    projectId?: string | null;
    resourceId?: string;
    expandedPaths?: string[];
}
export interface WorkbenchNavigationView extends SessionDirectoryView {
    statuses: Record<string, readonly import('@nestos/cells-driver/harness').HarnessStatusRow[]>;
}
/** Application composition owns observation and resources; command ports stay independent. */
export interface ConversationWorkbenchView {
    documents: Record<string, unknown>;
    workbench: WorkbenchView;
    native?: PreparedConversation;
    failure?: {resourceId: string; code: string; reason?: string};
    eventSnapshot(): {cursor: number; firstSequence: number; events: ApplicationViewEvent[]};
    subscribe(listener: (event: ApplicationViewEvent) => void, failed?: (failure: {code: string}) => void): Promise<() => void>;
    cursor: number;
    openConversation(resourceId: string): Promise<PreparedConversation>;
    readNavigation(request: WorkbenchNavigationRequest): Promise<WorkbenchNavigationView>;
    setVisible(visible: boolean): Promise<void>;
    dispose(): Promise<void>;
}

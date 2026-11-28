/** Host construction services. UI consumes ApplicationClient instead. */
import type { IFileSystem, IVFSManager } from '@nestos/vfs-core';
import type { ILLMService } from '@nestos/driver-llm/contracts';
import type { IConnectionService, IAgentManagementService, SessionCapabilityRegistry } from '@nestos/kernel-adapters/contracts';
import type { ISessionRepository, ICommandBus, SessionManagementPort } from '@nestos/llm-session/contracts';
import type { SnapshotPort } from '../settings';
import type { IToolService } from '@nestos/tools/contracts';
import type { KernelInspectionPort } from '@nestos/durable-kernel/contracts';
import type { DigitalTwinService } from './digital-twin';
import type { ModelConfigurationCommands } from './configuration';
import type { ProjectService } from './projects';
import type { SessionFilesService, DirectoryMountService } from './files';
import type { ProjectSyncService } from './sync';

export interface LocalApplicationServices {
    events?: import('./events').ApplicationEvents;
    diagnostics?: import('./diagnostics').ApplicationDiagnostics & {record?(event: Omit<import('./diagnostics').DiagnosticEvent, 'id' | 'timestamp'>): void};
    serviceControl?: import('./service-control').RuntimeServiceControl;
    editorSwapStore?: import('./editor-swap').EditorSwapStore;
    flowInstallations?: import('./flow-installation').FlowInstallations;
    toolPackages?: import('./flow-installation').ToolPackages;
    digitalTwin?: DigitalTwinService;
    dream?: import('./dream').DreamService;
    kanban?: import('@nestos/kanban/contracts').KanbanClient;
    kanbanHarnessDefaults?: Required<Pick<import('./application-client').ApplicationBackend,'readKanbanHarnessDefaults'|'saveKanbanHarnessDefaults'>>;
    vfs: IVFSManager;
    llmDriver: IConnectionService & { init(): Promise<void> };
    agentService: ApplicationAgentPort;
    configuration: ModelConfigurationCommands;
    sessionRepository: ISessionRepository;
    flowEngine: { engine: IFileSystem };
    sessionFiles: SessionFilesService;
    directoryMounts: DirectoryMountService;
    projects: ProjectService;
    projectSync?: ProjectSyncService;
    kernel: {
        kernel: ApplicationKernelPort & KernelInspectionPort;
        llmService: ILLMService;
        toolCatalog: Pick<IToolService, 'getToolDefinitions' | 'getToolMeta' | 'listTools'>;
        sessions: SessionCapabilityRegistry;
    };
    sessionManager: SessionManagementPort;
    commandBus: ICommandBus;
    startBackground?(): void;
    prepareSession?(sessionId: string): Promise<boolean>;
    acquireConversation?(sessionId: string): Promise<{ commandBus: ICommandBus; dispose(): Promise<void> }>;
}

export type ApplicationKernelPort = import('@nestos/durable-kernel/contracts').KernelViewPort;

export interface LocalBackendOptions {
    snapshots?(vfs: IVFSManager): SnapshotPort;
}

export interface ApplicationAgentPort extends IAgentManagementService {
    getAgentResourceId(id: string): string | undefined;
}

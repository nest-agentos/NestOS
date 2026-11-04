import type {EditorOptions} from '../contracts';

import type {ISessionRepository, SessionViewPort, ICommandBus} from '@nestos/llm-session/contracts';
import type {IAgentConfigService} from '@nestos/kernel-adapters/contracts';
import type {EditorTaskControlPlane} from '@nestos/durable-kernel/contracts';
import type {IPrivilegedCommandService} from '../domain/ports/IPrivilegedCommandService';
import type {WorkspaceHandoff} from './drafts/workspace-handoff';
import type {SessionLoadMetrics} from './load-metrics';

export interface LLMEditorOptions extends EditorOptions<import('@nestos/llm-flow/contracts').SessionSubmission, import('../services/SessionService').SessionLoadResult> {
    handoff?: WorkspaceHandoff;
    readTaskAttachment?: import('@nestos/durable-kernel/contracts').ReadTaskAttachment;
    configuration?: import('@nestos/kernel-adapters/contracts').ChatConfigurationView;
    sessionId: string;
    sessionRepository: ISessionRepository;
    sessionManager: SessionViewPort;
    defaultHarnessToolIds?: readonly string[];
    agentService: IAgentConfigService;
    initialInputState?: { text?: string; agentId?: string };
    /** Host-owned OCR capability and configuration. */
    ocr?: import('@nestos/app-contracts/services').OcrControls;
    /**
     * Conversation command bus returned by initializeConversationSystem().
     * High-level operations use the injected Session and VCS commands.
     */
    commandBus?: ICommandBus;
    /** Host task control and restoration port. */
    kernel?: EditorTaskControlPlane;
    /** Application service for durable privileged slash commands. */
    privilegedCommands?: IPrivilegedCommandService;
    sessionSkills?: import('@nestos/tools/contracts').SessionSkillControls;
    onLoadMetrics?: (metrics: SessionLoadMetrics) => void;
}

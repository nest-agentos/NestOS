import { TerminalSettingsEditor } from '../editors/TerminalSettingsEditor';
import { CellsSettingsEditor } from '../editors/CellsSettingsEditor';
import type { InitialFilesPort } from '../editors/initial-files';
import type { MCPServer, MCPDiscovery } from '@nestos/tools/mcp-contracts';
import type {ConfigurationFormControls} from '@nestos/ui-common-adapter';
import {editorResourceId} from '@nestos/ui-common-adapter';
// @file app-settings/factories/settingsFactory.ts
import type { IConnectionService, MediaProbeExamples } from '@nestos/kernel-adapters/contracts';
import type {EditorOptions} from '@nestos/ui-common-adapter';
import type { IAgentManagementService } from '@nestos/kernel-adapters/contracts';
import type {EditorFactory, IEditor} from '@nestos/ui-common-adapter';
import type { SettingsPort as SettingsService } from '@nestos/app-contracts/settings';
import { SETTINGS_PAGES } from '../engine/SettingsEngine';

import { TagSettingsEditor } from '../editors/TagSettingsEditor';
import { ContactSettingsEditor } from '../editors/ContactSettingsEditor';
import { StorageSettingsEditor } from '../editors/StorageSettingsEditor';
import { AboutSettingsEditor } from '../editors/AboutSettingsEditor';
import { RecoverySettingsEditor } from '../editors/RecoverySettingsEditor';
import { LogSettingsEditor } from '../editors/LogSettingsEditor';
import { SystemFSExploreEditor, type FileBrowserConnector } from '../editors/SystemFSExploreEditor';
import { AppearanceSettingsEditor } from '../editors/AppearanceSettingsEditor';

/** Injected UI editors from @nestos/llm-ui-adapter (to avoid upward dependency). */
export interface LLMUIEditors {
    ModelDefaultsEditor: new (container: HTMLElement, service: IConnectionService, options: EditorOptions, ocr?: import('@nestos/app-contracts/services').OcrControls) => IEditor;
    ProviderSettingsEditor: new (container: HTMLElement, service: IConnectionService, options: EditorOptions, examples?: MediaProbeExamples) => IEditor;
    ConnectionSettingsEditor: new (container: HTMLElement, service: IConnectionService, options: EditorOptions) => IEditor;
    MCPSettingsEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions, controls?: ConfigurationFormControls<MCPServer,MCPDiscovery>) => IEditor;
    CostEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions) => IEditor;
    SystemPromptSettingsEditor: new (container: HTMLElement, service: IAgentManagementService, options: EditorOptions) => IEditor;
}

/**
 * VFS-UI 使用 path（如 "/文件系统"）作为 nodeId，而内部编辑器用 slug（如 "storage"）。
 * 此函数将 path → 内部分类 slug，确保 switch 正确匹配。
 */
function resolveSettingsSlug(nodeId: string): string {
    // 直接匹配 slug（向后兼容）
    if (SETTINGS_PAGES[nodeId]) return nodeId;
    // 按 path 反向查找
    for (const [slug, cfg] of Object.entries(SETTINGS_PAGES)) {
        if (`/${cfg.name}` === nodeId) return slug;
    }
    return nodeId;
}

export interface SettingsFactoryOptions {
    cells?: import('@nestos/app-contracts/services').ProjectRemoteMountPort;
    serverTerminals?: import('@nestos/app-contracts/services').ServerTerminals;
    diagnostics?: import('@nestos/app-contracts/services').ApplicationDiagnostics;
    mediaProbeExamples?: MediaProbeExamples;
    ocr?: import('@nestos/app-contracts/services').OcrControls;
    settingsService: SettingsService;
    agentService: IAgentManagementService;
    connectionService: IConnectionService;
    llmUiEditors: LLMUIEditors | (() => Promise<LLMUIEditors>);
    connectBrowser: FileBrowserConnector;
    initialFiles?: InitialFilesPort;
    restoreFlows?: () => Promise<number>;
    requestDelete?: import('@nestos/ui-common-adapter').EditorHostContext['requestDelete'];
}
export const createSettingsFactory = ({ settingsService, agentService, connectionService, llmUiEditors,
    connectBrowser, restoreFlows, initialFiles, requestDelete, ocr, mediaProbeExamples, diagnostics, serverTerminals, cells }: SettingsFactoryOptions): EditorFactory => {
    return async (container: HTMLElement, options: EditorOptions) => {
        if (requestDelete) options = { ...options, hostContext: { toggleSidebar: () => {}, navigate: async () => {}, ...options.hostContext, requestDelete } };
        const nodeId = resolveSettingsSlug(editorResourceId(options) || '');
        const editors = ['model-defaults', 'providers', 'connections', 'mcp-servers', 'cost', 'system-prompts'].includes(nodeId)
            ? typeof llmUiEditors === 'function' ? await llmUiEditors() : llmUiEditors : undefined;

        let editor: IEditor | null = null;

        switch (nodeId) {
            case 'cells': editor = new CellsSettingsEditor(container, cells, options); break;
            case 'terminal': editor = new TerminalSettingsEditor(container, serverTerminals, options); break;
            case 'model-defaults': editor = new editors!.ModelDefaultsEditor(container, connectionService, options, ocr); break;
            case 'storage':     editor = new StorageSettingsEditor(container, settingsService, options); break;
            case 'tags':        editor = new TagSettingsEditor(container, settingsService, options); break;
            case 'contacts':    editor = new ContactSettingsEditor(container, settingsService, options); break;
            case 'providers':   editor = new editors!.ProviderSettingsEditor(container, connectionService, options, mediaProbeExamples); break;
            case 'connections': editor = new editors!.ConnectionSettingsEditor(container, connectionService, options); break;
            case 'mcp-servers': editor = new editors!.MCPSettingsEditor(container, agentService, options); break;
            case 'cost':        editor = new editors!.CostEditor(container, agentService, options); break;
            case 'system-prompts': editor = new editors!.SystemPromptSettingsEditor(container, agentService, options); break;
            case 'recovery':    editor = new RecoverySettingsEditor(container, agentService, options, restoreFlows, initialFiles); break;
            case 'log':         editor = new LogSettingsEditor(container, settingsService, options, diagnostics); break;
            case 'about':       editor = new AboutSettingsEditor(container, settingsService, options); break;
            case 'fs-explorer': editor = new SystemFSExploreEditor(container, settingsService, options, connectBrowser); break;
            case 'appearance':  editor = new AppearanceSettingsEditor(container, settingsService, options); break;
            default:
                container.innerHTML = `<div style="padding:2rem;text-align:center;color:#666">Select a setting category</div>`;
                return { init: async () => {}, destroy: async () => {}, getText: () => '', setText: () => {}, focus: () => {}, getMode: () => 'render', switchToMode: async () => {}, setTitle: () => {}, setReadOnly: () => {}, isDirty: () => false, setDirty: () => {}, commands: {}, getHeadings: async () => [], getSearchableText: async () => '', getSummary: async () => null, search: async () => [], gotoMatch: () => {}, clearSearch: () => {}, on: () => () => {}, navigateTo: async () => {} } as unknown as IEditor;
        }

        if (editor) {
            // @ts-ignore BaseSettingsEditor has init method
            await editor.init(container);
        }

        return editor!;
    };
};

import {projectActionPath} from '../projects/project-action-route';
import {CellsSettingsEditor} from '@nestos/app-settings';
import {MCPDiagnosticsControls} from './mcp-diagnostics';
import { RemoteAgentDetailsEditor } from './RemoteAgentDetailsEditor';
import { MCPConfigurationControlsRegistry } from './mcp-controls';
import type { ApplicationServices } from '@nestos/app-contracts/services';
import type { ToolboxResources } from '@nestos/app-contracts/services';
import type { NavigationRequest } from '@nestos/common';
import type { EditorFactory } from '@nestos/ui-common-adapter';
import type { AppUI } from '../types';
import type { VFSNodeUI, UIPersistencePort } from '@nestos/vfs-ui';
import type { ToolboxInventory } from '@nestos/app-contracts/services';
import { ToolboxWorkbench, type ToolboxPreferencesPort } from './ToolboxWorkbench';
import { ToolDetailsEditor } from './ToolDetailsEditor';
import { createWorkspaceModule, type WorkspaceModule } from '../workspaces/module';
import mediaProbeExamples from '../config/media-probe-examples.json';
import type { MediaProbeExamples } from '@nestos/kernel-adapters/contracts';

interface Options {
    backend: import('@nestos/app-contracts/services').ApplicationBackend;
    ocr?: import('../configuration/ocr-controls').OcrConfigurationControls;
    services: Pick<ApplicationServices, 'vfs' | 'agentService' | 'commandBus' | 'kernel' | 'flowEngine' | 'configuration' | 'projects'>;
    ui: Pick<AppUI, 'llmUiEditors' | 'createFlowContextMenu'>;
    sidebar: HTMLElement; editor: HTMLElement;
    factories: Record<'agents' | 'skills' | 'flows', EditorFactory>;
    navigate(request: NavigationRequest): Promise<void>; selected(path: string | null): void; onBeforeNavigate?(): void;
    uiPersistence?: UIPersistencePort;
    uiPreferences?: ToolboxPreferencesPort;
    executorUsage?: import('@nestos/ui-common-adapter').EditorOptions['executorUsage'];
    agentsInWorkbench?: boolean;
    workbenchState?: import('../workbench/state').WorkbenchStatePort;
    windows?: import('../workbench/windows').WorkbenchWindowBinding;
}
/** The toolbox owns its projection lifetime and editor wiring as one module. */
export async function createToolboxModule(options: Options): Promise<WorkspaceModule> {
    const { commandBus } = options.services;
    const view = await options.backend.toolboxView(), { inventory, resources, files } = view;
    try {
        let workbench: ToolboxWorkbench;
        const factories = configurationFactories(options, inventory, resources, id => workbench.openCellsNode(id));
        workbench = new ToolboxWorkbench({ ...options, inventory, resources, files, initial: view.initial, factories, configuration: options.services.configuration, projects: options.services.projects,
            flowMenu: options.ui.createFlowContextMenu<VFSNodeUI>({ commands: commandBus,
                navigate: id => options.navigate({ target: 'chat', resourceId: id }) }) });
        return createWorkspaceModule(workbench, async () => { try { await workbench.destroy(); } finally { await view.dispose(); } });
    } catch (error) { await view.dispose(); throw error; }
}
function configurationFactories(options: Options, inventory: ToolboxInventory, resources: ToolboxResources, openCells: (id?: string) => Promise<void>) {
    const { agentService } = options.services;
    const editors = () => typeof options.ui.llmUiEditors === 'function' ? options.ui.llmUiEditors() : Promise.resolve(options.ui.llmUiEditors);
    const create = (key: 'SystemPromptSettingsEditor' | 'ProviderSettingsEditor' | 'ConnectionSettingsEditor', examples?: MediaProbeExamples): EditorFactory => async (element, config) => {
        const loaded = await editors();
        const editor = key === 'ProviderSettingsEditor' ? new loaded.ProviderSettingsEditor(element, agentService, config, examples)
            : new loaded[key](element, agentService, config);
        await editor.init(element); return editor;
    };
    return { ...options.factories, cells: async (element: HTMLElement, config: import('@nestos/ui-common-adapter').EditorOptions) => {
        const editor = new CellsSettingsEditor(element, options.services.projects?.remoteMounts, config, {saved: id => openCells(id), removed: () => openCells(),
            project: (mount,action) => options.navigate({target:'chat',resourceId:projectActionPath(mount.projectId,action,mount.mountId)})}); await editor.init(element); return editor;
    }, agents: async (element: HTMLElement, config: import('@nestos/ui-common-adapter').EditorOptions) => {
        if (config.target?.kind === 'file' && config.target.path.startsWith('/@remote/')) {
            const editor = new RemoteAgentDetailsEditor(element, inventory, config, options.services.projects); await editor.init(element); return editor;
        }
        return options.factories.agents(element, config);
    }, prompts: create('SystemPromptSettingsEditor'), providers: create('ProviderSettingsEditor', mediaProbeExamples), connections: create('ConnectionSettingsEditor'),
        mcp: async (element: HTMLElement, config: import('@nestos/ui-common-adapter').EditorOptions) => {
            const remote = options.services.projects?.remoteMounts;
            const controls = new MCPConfigurationControlsRegistry().register('diagnostics', new MCPDiagnosticsControls(options.backend.diagnostics, remote), () => true);
            const Editor = (await editors()).MCPSettingsEditor;
            const editor = new Editor(element, agentService, config, controls); await editor.init(element); return editor;
        }, tools: async (element: HTMLElement, config: import('@nestos/ui-common-adapter').EditorOptions) => {
            const editor = new ToolDetailsEditor(element, inventory, config, resources); await editor.init(element); return editor;
        } };
}

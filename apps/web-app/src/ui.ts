import type { AppUI } from '@nestos/app-shell';
import type { ChatEditorOptions } from '@nestos/llm-ui-adapter/contracts';
import { createFlowContextMenuConfig, createAIContextMenuConfig,
    restoreFlowLibrary } from '@nestos/llm-ui-adapter/startup';

import {loadChatEditor, loadNativeEditor} from './editor-modules';
export {preloadBrowserEditor} from './editor-modules';

type EditorFactory = ReturnType<AppUI['createChatEditor']>;

function lazyEditorFactory(load: () => Promise<EditorFactory>): EditorFactory {
    let pending: Promise<EditorFactory> | undefined;
    return async (container, options) => (await (pending ??= load()))(container, options);
}

export function createBrowserUI(library: Parameters<typeof restoreFlowLibrary>[1]): AppUI {
    return {
        prepareChatSubmission: async options => (await import('@nestos/llm-ui-adapter/independent')).prepareSessionChatRequest(options),
        createChatEditor: (service, deps) => {
            const chat = lazyEditorFactory(async () => (await loadChatEditor()).createLLMFactory(service, deps));
            return async (container, options: ChatEditorOptions) => {
                if (!options.conversation) return chat(container, options);
                const native = await loadNativeEditor();
                return native.createConversationEditor(container, options.conversation, {...options, savedPrompts: native.savedPromptControls(deps)}, undefined, deps.ocr);
            };
        },
        createAgentEditor: (service, capabilities) => lazyEditorFactory(async () =>
            (await import('@nestos/llm-ui-adapter/settings')).createAgentEditorFactory(service, capabilities)),
        createFlowEditor: deps => lazyEditorFactory(async () =>
            (await loadChatEditor()).createFlowsEditorFactory(deps)),
        createFlowContextMenu: deps => createFlowContextMenuConfig({ ...deps, library: library }),
        restoreFlowLibrary: commands => restoreFlowLibrary(commands, library),
        createSkillEditor: service => lazyEditorFactory(async () =>
            (await import('@nestos/llm-ui-adapter/settings')).createSkillsEditorFactory(service)),
        createAIContextMenu: createAIContextMenuConfig,
        llmUiEditors: () => import('@nestos/llm-ui-adapter/settings'),
    };
}

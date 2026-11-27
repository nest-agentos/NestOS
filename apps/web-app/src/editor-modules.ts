let chatModule: ReturnType<typeof importChat> | undefined;
const importChat = () => import('@nestos/llm-ui-adapter/chat');
export const loadChatEditor = () => chatModule ??= importChat();
const importConversation = () => import('@nestos/llm-ui-adapter/conversation');
let nativeModule: ReturnType<typeof importConversation> | undefined;
export const loadNativeEditor = () => nativeModule ??= importConversation();

/** Only the editor selected by the current route is fetched before shell assembly. */
export async function preloadBrowserEditor(type?: string): Promise<void> {
    if (type === 'native') await loadNativeEditor();
    if (type === 'chat' || type === 'flows') await loadChatEditor();
}

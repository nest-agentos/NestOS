export const SESSION_BROWSER_SCOPE = 'session-browser:v1:admin';
export const EXECUTOR_USAGE_DOCUMENT = 'mindos_executor_usage_v1';
export const INITIAL_NATIVE_CHAT_DOCUMENTS = ['theme', `${SESSION_BROWSER_SCOPE}.ui`, `${SESSION_BROWSER_SCOPE}.workbench`];
export const INITIAL_CHAT_DOCUMENTS = [...INITIAL_NATIVE_CHAT_DOCUMENTS, EXECUTOR_USAGE_DOCUMENT, 'nestos_assistant_menu_v1'];

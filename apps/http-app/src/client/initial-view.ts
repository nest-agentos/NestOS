import {initialReadRequest, initialViewRequest, INITIAL_CHAT_DOCUMENTS, INITIAL_NATIVE_CHAT_DOCUMENTS, parseWorkspaceHash} from '@nestos/app-shell/startup';
import {ROUTE_ALIASES} from 'nestos-web/routes';
import {parseSessionRoute, resolveBrowserTarget} from '@nestos/app-contracts/routing';

export function initialView(hash: string) {
    const route = parseWorkspaceHash(hash, 'start');
    const chat = route.slug === 'chat' || Object.hasOwn(ROUTE_ALIASES, route.slug);
    const editor = chat ? chatEditor(route.resource) : route.slug;
    const request = chat ? initialViewRequest(INITIAL_CHAT_DOCUMENTS, route.resource) : undefined;
    const nativeConversation = editor === 'chat' && !!request?.resourceId;
    if (nativeConversation && request) request.documents = INITIAL_NATIVE_CHAT_DOCUMENTS;
    return {nativeConversation, initialRead:chat?undefined:initialReadRequest(route),request,editor};
}

function chatEditor(resource?: string): 'chat' | undefined {
    if (!resource) return;
    if (resource.replace(/^\//, '').startsWith('draft:')) return 'chat';
    try {
        const target = resolveBrowserTarget(parseSessionRoute(resource).path);
        if (target.kind === 'session' || target.kind === 'project-draft'
            || target.kind === 'remote' && (target.nativeSessionId || target.draft)) return 'chat';
    } catch { /* The resource loader reports invalid routes without fetching an unrelated editor. */ }
}

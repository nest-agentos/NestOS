import {parseSessionRoute, resolveBrowserTarget} from '@nestos/app-contracts/routing';
import type {ApplicationBackend, OpenedApplicationView, OpenViewRequest} from '@nestos/app-contracts/services';
import {MOBILE_NAVIGATION_QUERY} from '@nestos/ui-common';
import {SESSION_BROWSER_SCOPE} from '../persistence/documents';

export function openInitialView(backend: ApplicationBackend, documents: string[], resource?: string): Promise<OpenedApplicationView> {
    return backend.openView(initialViewRequest(documents, resource));
}

export function initialViewRequest(documents: string[], resource?: string): OpenViewRequest {
    let initialSessionId: string | undefined, branch: string | undefined, initialResource: string | undefined;
    let initialPage: OpenViewRequest['initialPage'];
    try {
        const route = resource && !resource.startsWith('@project/') ? parseSessionRoute(resource) : undefined;
        const target = route && resolveBrowserTarget(route.path);
        if (target && (target.kind === 'remote' && target.nativeSessionId || ['project-draft', 'project-files', 'favorites', 'favorite', 'folder'].includes(target.kind))) initialResource = route!.path;
        if (target?.kind === 'session') {initialSessionId = target.sessionId; branch = route?.branch;}
        if (target?.kind === 'remote' && target.nativeSessionId) initialPage = {
            sidebar: !globalThis.matchMedia?.(MOBILE_NAVIGATION_QUERY).matches, composer: !target.archived, sidebarDocument: `${SESSION_BROWSER_SCOPE}.ui`,
        };
    } catch { /* The normal resource loader owns malformed-route diagnostics. */ }
    return {documents, resourceId: initialResource, branch, taskAttachmentKey: 'ui.privileged.active-task', ...(initialPage && {initialPage}),
        workbench: {chatControls: true, initialNavigation: !resource, initialSessionId, displayedFilesPolicy: 'gitignore' as const}};
}

import {ACTION_ICONS, randomUUID, t} from '@nestos/common';
import type {KanbanClient, KanbanDeletionPreview} from '@nestos/kanban/contracts';
import type {BrowserDeletion, BrowserNode} from '@nestos/vfs-ui';

/** The sidebar exposes logical resources; lifecycle and Git validation remain on the server. */
export function kanbanSidebarDeletion(service: KanbanClient | undefined, removed: (node: BrowserNode) => Promise<void>): BrowserDeletion | undefined {
    if (!service?.previewDeletion || !service.deleteBoard) return undefined;
    return {label: t('kanban.deleteBoard'), cancelLabel: t('kanban.deleteCancel'), iconHTML: ACTION_ICONS.delete,
        preview: async node => {
            const data = await service.previewDeletion!(boardId(node));
            const lines = [t('kanban.deleteDescription'), `${data.title} · ${t('kanban.deletePending')}: ${data.pendingItems}`];
            for (const blocker of data.blockers) lines.push(`${t('kanban.deleteBlocked')}: ${reason(blocker.code)}${blocker.itemId ? ` (${blocker.itemId})` : ''}${blocker.sessionId ? ` · ${blocker.sessionId}` : ''}`);
            for (const {resource} of data.resources) lines.push(`${resource.title} · ${resource.location}\n${resource.state === 'cleaned' ? t('kanban.deleteCleaned') : resource.canCleanup ? t('kanban.deleteCleanupReady') : `${t('kanban.deleteRetained')}: ${resource.reasons.map(reason).join(', ')}`}`);
            const ready = data.resources.filter(row => row.resource.canCleanup).length;
            return {message: lines.join('\n\n'), blocked: data.blockers.length > 0, data: {...data, operationId: randomUUID()},
                choices: ready ? [{id: 'cleanup', label: `${t('kanban.deleteCleanup')} (${ready})`, checked: true}] : []};
        },
        remove: async (node, preview, choices) => {
            const data = preview.data as KanbanDeletionPreview & {operationId: string};
            await service.deleteBoard!(boardId(node), {operationId: data.operationId, expectedRevision: data.revision, version: data.version, cleanup: choices.has('cleanup')});
            await removed(node);
        }};
}
function boardId(node: BrowserNode): string {return decodeURIComponent(node.id.split('/')[2]);}
function reason(code: string): string {
    const key = `kanban.errors.${code}` as Parameters<typeof t>[0], translated = t(key);
    return translated === key ? code : translated;
}

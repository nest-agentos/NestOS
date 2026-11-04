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
            lines.push(...blockerSummaries(data));
            const resources = uniqueResources(data);
            for (const rows of resources.values()) lines.push(resourceSummary(data, rows));
            if (data.blockers.length) lines.push(t('kanban.deleteResolveHint'));
            const ready = [...resources.values()].filter(rows => rows.every(row => row.resource.canCleanup)).length;
            return {message: lines.join('\n\n'), blocked: data.blockers.length > 0,
                details: {label: t('kanban.deleteDiagnostics'), text: diagnostics(data)}, data: {...data, operationId: randomUUID()},
                choices: ready ? [{id: 'cleanup', label: `${t('kanban.deleteCleanup')} (${ready})`, checked: true}] : []};
        },
        remove: async (node, preview, choices) => {
            const data = preview.data as KanbanDeletionPreview & {operationId: string};
            await service.deleteBoard!(boardId(node), {operationId: data.operationId, expectedRevision: data.revision, version: data.version, cleanup: choices.has('cleanup')});
            await removed(node);
        }};
}
function boardId(node: BrowserNode): string {return decodeURIComponent(node.id.split('/')[2]);}
function blockerSummaries(data: KanbanDeletionPreview): string[] {
    const groups = new Map<string, Set<string>>();
    for (const blocker of data.blockers) {
        const id = blocker.itemId ?? '', reasons = groups.get(id) ?? new Set<string>();
        reasons.add(reason(blocker.code)); groups.set(id, reasons);
    }
    return [...groups].map(([id, reasons]) => `${id ? data.itemTitles?.[id] ?? t('kanban.deleteUnnamedItem') : data.title}\n${[...reasons].map(text => `• ${text}`).join('\n')}`);
}
function resourceSummary(data: KanbanDeletionPreview, rows: KanbanDeletionPreview['resources']): string {
    const resource = rows[0].resource, reasons = [...new Set(rows.flatMap(row => row.resource.reasons))];
    const names = [...new Set(rows.map(row => data.itemTitles?.[row.itemId] ?? t('kanban.deleteUnnamedItem')))];
    let state: string;
    if (resource.state === 'cleaned') state = t('kanban.deleteCleaned');
    else if (reasons.includes('WORKTREE_MISSING')) state = t('kanban.deleteResourceMissing');
    else {
        state = rows.every(row => row.resource.canCleanup) ? t('kanban.deleteCleanupReady') : t('kanban.deleteRetained');
        if (reasons.length) state += `：${reasons.map(reason).join('；')}`;
    }
    return `${names.join('、')} · ${resource.title}\n${state}`;
}
function uniqueResources(data: KanbanDeletionPreview): Map<string, KanbanDeletionPreview['resources']> {
    const groups = new Map<string, KanbanDeletionPreview['resources']>();
    for (const row of data.resources) {
        const key = JSON.stringify([row.resource.kind, row.resource.id, row.resource.location]);
        const rows = groups.get(key) ?? []; rows.push(row); groups.set(key, rows);
    }
    return groups;
}
function diagnostics(data: KanbanDeletionPreview): string {
    return [data.boardId, ...data.blockers.map(row => [row.code, row.itemId, row.sessionId].filter(Boolean).join(' · ')),
        ...[...uniqueResources(data).values()].map(rows => `${rows[0].resource.location}\n${[...new Set(rows.flatMap(row => row.resource.reasons))].join(', ')}`)].join('\n\n');
}
function reason(code: string): string {
    for (const prefix of ['kanban.errors', 'kanban.workResourceReason']) {
        const key = `${prefix}.${code}` as Parameters<typeof t>[0], translated = t(key);
        if (translated !== key) return translated;
    }
    return t('kanban.deleteUnknownReason');
}

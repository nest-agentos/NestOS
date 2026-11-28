/** Builds the suffix after `<slot>-` for pinned file tabs. */
export function fileWindowLabel(path: string, projectId?: string): string {
    const normalized = path.replace(/^\/+/, '');
    if (!projectId) return normalized;
    const relative = normalized.startsWith('workspace/') ? normalized.slice('workspace/'.length) : normalized;
    return `${projectId}-${relative}`;
}

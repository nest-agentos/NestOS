import {t} from '@nestos/common';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import type {DirectoryPreviewOptions, VFSNodeUI} from '@nestos/vfs-ui';

/** Sidebars preview sorted members; complete directory pages keep their canonical routes. */
export function projectNavigationPreview(node: VFSNodeUI, open: (path: string) => Promise<void>): DirectoryPreviewOptions | undefined {
    const kind = resolveBrowserTarget(node.id).kind;
    if (kind !== 'project-files' && kind !== 'favorites') return undefined;
    return {limit: 15, moreLabel: '… ' + t(kind === 'favorites' ? 'project.moreFavorites' : 'project.moreFiles'),
        open: directory => open(directory.id)};
}

import { CHAT_ICONS, harnessPresentation, t } from '@nestos/common';
import { projectConversationsPath, projectConversationEntryPath, remoteSessionPath, resolveBrowserTarget, type BrowserTarget } from '@nestos/app-contracts';
import type { FSNode } from '@nestos/vfs-core';
import type { RemoteSessionProjection } from '../session/remote-session-projection';
import { readConversationPage, type ConversationSource } from './conversation-page';
import { FSError } from '@nestos/vfs-core';

function aliasNode(directory: string, node: FSNode): FSNode {
    return {...node, path: projectConversationEntryPath(directory, node.path), parentPath: directory,
        name: '@entry:' + encodeURIComponent(node.path), metadata: {...node.metadata, navigationTarget: node.path}};
}
function unavailableNode(folder: string, source: string): FSNode {
    const node = conversationDirectoryNode(folder);
    return {...node, path: remoteSessionPath(folder, source === 'remote' ? undefined : source.replace(/^remote:/, '')), type: 'file', size: 0,
        metadata: {...node.metadata, title: t('project.sourceUnavailable', {name: harnessPresentation(source.replace(/^remote:/, '')).label}), _disabled: true}};
}
function continuationNode(directory: string, target: Extract<BrowserTarget, {kind: 'project-conversations'}>, cursor: string): FSNode {
    const node = conversationDirectoryNode(target.folder);
    if (target.recent) return aliasNode(directory, {...node, metadata: {...node.metadata, title: t('project.moreConversations'), conversationMore: true}});
    const path = directory + '/@page:' + encodeURIComponent(cursor);
    return {...node, path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: directory,
        metadata: {...node.metadata, title: t('harness.more'), conversationMore: true, navigationTarget: path}};
}

export function conversationDirectoryNode(folder: string, recent = false, cursor?: string): FSNode {
    const path = projectConversationsPath(folder, {recent, cursor});
    return {path, name: path.slice(path.lastIndexOf('/') + 1), parentPath: path.slice(0, path.lastIndexOf('/')), type: 'directory',
        createdAt: 0, modifiedAt: 0, version: 1, tags: [], icon: CHAT_ICONS.more,
        metadata: {title: t('project.conversations'), _readOnly: true, _fixedEntry: true, _showAll: true, _fileDetails: false,
            ...(recent ? {navigationTransparent: true, directoryPath: projectConversationsPath(folder)} : {})}};
}
export function conversationNavigationNodes(folder: string): FSNode[] {
    const full = conversationDirectoryNode(folder);
    return [conversationDirectoryNode(folder, true), {...full, metadata: {...full.metadata, navigationHidden: true}}];
}

/** Derive the sidebar window from an already requested full page, keeping canonical identities. */
export function recentConversationPreview(folder: string, nodes: FSNode[]): FSNode[] {
    const directory = projectConversationsPath(folder, {recent: true});
    const sessions = nodes.filter(node => {
        const target = resolveBrowserTarget(String(node.metadata.navigationTarget ?? node.path));
        return target.kind === 'session' || target.kind === 'remote' && !!target.nativeSessionId;
    });
    const preview = sessions.slice(0, 15).map(node => aliasNode(directory,
        {...node, path: String(node.metadata.navigationTarget ?? node.path)}));
    for (const node of nodes.filter(node => node.metadata._disabled))
        preview.push(aliasNode(directory, {...node, path: String(node.metadata.navigationTarget ?? node.path)}));
    if (sessions.length > 15 || nodes.some(node => node.metadata.conversationMore))
        preview.push(continuationNode(directory, {kind: 'project-conversations', folder, recent: true}, ''));
    return preview;
}

export async function conversationDirectory(directory: string, target: Extract<BrowserTarget, {kind: 'project-conversations'}>,
    local: ConversationSource[], remote: () => ReturnType<RemoteSessionProjection['timeline']>, agentId?: string): Promise<FSNode[]> {
    const timeline = await remote();
    try {
        const page = await readConversationPage([...local, ...timeline.sources], filteredCursor(target.cursor, agentId), target.recent ? 15 : 50);
        const errors = page.errors.map(({source}) => unavailableNode(target.folder, source));
        const actions = target.recent ? [] : timeline.actions.filter(action => !action.path.endsWith('/@new'));
        const nodes = [...actions, ...page.nodes, ...errors].map(node => aliasNode(directory, node));
        if (page.cursor) nodes.push(continuationNode(directory, target, agentId ? JSON.stringify({agentId, cursor: page.cursor}) : page.cursor));
        return nodes;
    } finally {await timeline.close();}
}
function filteredCursor(cursor?: string, agentId?: string): string | undefined {
    if (!cursor || !agentId) return cursor;
    let value: {agentId?: unknown; cursor?: unknown};
    try {value = JSON.parse(cursor);} catch {throw new FSError('EINVAL', 'Invalid filtered conversation cursor');}
    if (value.agentId !== agentId || typeof value.cursor !== 'string') throw new FSError('EINVAL', 'Conversation filter changed; reopen the conversation list');
    return value.cursor;
}

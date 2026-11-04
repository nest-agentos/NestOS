import type { ISeqFileTransaction } from '@nestos/vfs-core';
import type { SessionSummary } from './types';

export const NAVIGATION_PATH = '/var/lib/sessions/folders.seq';
export const NAVIGATION_VERSION = 'navigation-version';
export const NAVIGATION_REVISION = 'navigation-revision';
export const NAVIGATION_SCHEMA = '2';
export const recentNavigationPrefix = (folder: string | null, agentId?: string) =>
    `recent/${encodeURIComponent(folder ?? '')}/${agentId ? 'agent/' + encodeURIComponent(agentId) : 'all'}/`;
export function recentNavigationKey(folder: string | null, updatedAt: number, id: string, agentId?: string): string {
    const time = Number.isFinite(updatedAt) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(updatedAt))) : 0;
    return recentNavigationPrefix(folder, agentId) + `${String(Number.MAX_SAFE_INTEGER - time).padStart(16, '0')}/${id}`;
}
function recentKeys(session: SessionSummary): string[] {
    return [recentNavigationKey(session.folder ?? null, session.updatedAt, session.id),
        ...(session.createdWithAgentId ? [recentNavigationKey(session.folder ?? null, session.updatedAt, session.id, session.createdWithAgentId)] : [])];
}
function serializeRecentSummary(session: SessionSummary): string {
    const {id, title, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId} = session;
    return JSON.stringify({id, title, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId});
}
async function indexRecent(tx: ISeqFileTransaction, session: SessionSummary, before?: SessionSummary | null): Promise<void> {
    const location = `recent-location/${session.id}`, keys = recentKeys(session);
    const old: string[] = before ? recentKeys(before) : JSON.parse(await tx.getEntry(NAVIGATION_PATH, location) ?? '[]');
    for (const key of old) if (!keys.includes(key)) await tx.deleteEntry(NAVIGATION_PATH, key);
    for (const key of keys) await tx.setEntry(NAVIGATION_PATH, key, serializeRecentSummary(session));
    await tx.setEntry(NAVIGATION_PATH, location, JSON.stringify(keys));
}
export const navigationPrefix = (folder: string | null) => `navigation/${encodeURIComponent(folder ?? '')}/`;

export function serializeSessionSummary(session: SessionSummary): string {
    const { id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId } = session;
    return JSON.stringify({ id, title, summary, origin, createdAt, updatedAt, folder, parentSessionId, createdWithAgentId });
}

/** Publish directory rows in the same transaction as the authoritative Session metadata. */
export async function indexSessionSummary(tx: ISeqFileTransaction, session: SessionSummary, before?: SessionSummary | null): Promise<void> {
    const location = `navigation-location/${session.id}`;
    const previous = before === undefined ? await tx.getEntry(NAVIGATION_PATH, location)
        : before ? navigationPrefix(before.folder ?? null) + before.id : null;
    const key = navigationPrefix(session.folder ?? null) + session.id;
    if (previous && previous !== key) await tx.deleteEntry(NAVIGATION_PATH, previous);
    await tx.setEntry(NAVIGATION_PATH, key, serializeSessionSummary(session));
    await tx.setEntry(NAVIGATION_PATH, location, key);
    await indexRecent(tx, session, before);
    if (await tx.getEntry(NAVIGATION_PATH, NAVIGATION_VERSION) !== NAVIGATION_SCHEMA) {
        const revision = Number(await tx.getEntry(NAVIGATION_PATH, NAVIGATION_REVISION) ?? 0);
        await tx.setEntry(NAVIGATION_PATH, NAVIGATION_REVISION, String(revision + 1));
    }
}

export async function removeSessionSummary(tx: ISeqFileTransaction, id: string): Promise<void> {
    const location = `navigation-location/${id}`;
    const key = await tx.getEntry(NAVIGATION_PATH, location);
    if (key) await tx.deleteEntry(NAVIGATION_PATH, key);
    await tx.deleteEntry(NAVIGATION_PATH, location);
    const recentLocation = `recent-location/${id}`;
    const recent: string[] = JSON.parse(await tx.getEntry(NAVIGATION_PATH, recentLocation) ?? '[]');
    for (const key of recent) await tx.deleteEntry(NAVIGATION_PATH, key);
    await tx.deleteEntry(NAVIGATION_PATH, recentLocation);
    if (await tx.getEntry(NAVIGATION_PATH, NAVIGATION_VERSION) !== NAVIGATION_SCHEMA) {
        const revision = Number(await tx.getEntry(NAVIGATION_PATH, NAVIGATION_REVISION) ?? 0);
        await tx.setEntry(NAVIGATION_PATH, NAVIGATION_REVISION, String(revision + 1));
    }
}

import { FSError } from '@nestos/vfs-core';
import type { HarnessClient, HarnessHistory } from '@nestos/cells-driver';
import type { ProjectService, ProjectFolder } from '@nestos/app-contracts/services';
import type { TwinSourceCatalog, TwinSourceContent } from './domain';
import { sha256HexSync } from '@nestos/llm-context';
import {TWIN_MANAGED_SOURCE_MAX_BYTES} from './chunking';

export const harnessTarget = (project: string, profile: string, session: string) => JSON.stringify([project, profile, session]);
export async function discoverHarness(projects: ProjectService, project: ProjectFolder, catalog: TwinSourceCatalog, active: () => boolean = () => true): Promise<void> {
    if (!active() || !projects.remoteMounts?.list(project.project.id).some(mount => mount.at === '/' && mount.connectionId && mount.serverProjectId)) return;
    let client: HarnessClient | undefined;
    try {
        client = await projects.remoteMounts.projectHarness(project.project.id, { timeoutMs: 5000 });
        if (!active()) return;
        const resources: TwinSourceCatalog['resources'] = [];
        for (const profile of (await client.profiles({ timeoutMs: 5000 })).profiles.filter(item => item.capabilities.history && item.projectRuntime)) {
            if (!active()) return;
            for (const archived of [false, true]) {
                if (!active()) return;
                let cursor: string | undefined; const seen = new Set<string>();
                do {
                    if (!active()) return;
                    const page = await client.list(profile.id, { archived, cursor, limit: 100 }, { timeoutMs: 5000 });
                    if (!active()) return;
                    for (const session of page.sessions) resources.push({ kind: 'harness-session', location: 'remote', projectId: project.project.id, projectName: project.name, profileId: profile.id,
                        sessionId: session.id, target: harnessTarget(project.project.id, profile.id, session.id), label: session.title, version: String(session.updatedAt) });
                    if (resources.length > 10000 || (page.nextCursor && seen.has(page.nextCursor))) throw new Error('TWIN_SOURCE_LIMIT');
                    cursor = page.nextCursor ?? undefined; if (cursor) seen.add(cursor);
                } while (cursor);
            }
        }
        if (!active()) return;
        catalog.resources.push(...resources); catalog.completeScopes.push(`${project.project.id}/harness-session`);
    } catch { catalog.errors.push(`${project.project.id}/harness-session`); }
    finally { await client?.close(); }
}
export async function readHarness(projects: ProjectService, target: string): Promise<TwinSourceContent> {
    const [projectId, profileId, sessionId] = parseTarget(target);
    const client = await projects.remoteMounts?.projectHarness(projectId, { timeoutMs: 5000 });
    if (!client) throw new FSError('ENOENT', 'Harness project missing');
    try {
        const root = projects.remoteMounts?.list(projectId).find(mount => mount.at === '/');
        const binding = [root?.connectionId, root?.serverId, root?.serverProjectId];
        const texts: string[] = [], seen = new Set<string>(); let cursor: string | undefined, identity = '', nativeIdentity = '', bytes = 0;
        do {
            const history = await client.read(profileId, sessionId, { cursor, timeoutMs: 5000, toolDetail: 'summary' });
            if (history.session.activeTurnId || !['idle', 'notLoaded', null].includes(history.session.status)) throw new Error('TWIN_SOURCE_BUSY');
            const current = JSON.stringify([binding, projectId, profileId, sessionId, history.session.createdAt, history.session.updatedAt]);
            if (identity && identity !== current) throw new Error('TWIN_SOURCE_CHANGED'); identity = current;
            nativeIdentity = JSON.stringify([binding, projectId, profileId, sessionId, history.session.createdAt]);
            const text = publicHarnessText(history); bytes += new TextEncoder().encode(text).length; texts.push(text);
            if (bytes > 1024 * 1024 || (history.nextCursor && seen.has(history.nextCursor))) throw new Error('TWIN_SOURCE_LIMIT');
            cursor = history.nextCursor ?? undefined; if (cursor) seen.add(cursor);
        } while (cursor);
        const text = texts.join('\n'); return { text, hash: sha256HexSync(text), nativeIdentity };
    } finally { await client.close(); }
}
/** Read a provenance-filtered page with a revision fence and measured server-side I/O. */
export async function readHarnessWindow(projects: ProjectService, target: string, maxRounds: number, previousCursor?: string | null): Promise<TwinSourceContent & {scannedRounds: number; hasOlder?: boolean; historyBytes: number; contextBytes: number; cursor: string}> {
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 20) throw new Error('TWIN_SOURCE_LIMIT');
    const [projectId, profileId, sessionId] = parseTarget(target);
    const mounts = projects.remoteMounts, root = mounts?.list(projectId).find(mount => mount.at === '/');
    const client = await mounts?.projectHarness(projectId, {timeoutMs: 5000});
    if (!client) throw new Error('TWIN_SOURCE_SCOPE');
    try {
        if (!root?.connectionId || !root.serverId || !root.serverProjectId || !client.digest) throw new Error('TWIN_DIGEST_UNAVAILABLE');
        const metadata = await client.digest(profileId, sessionId, {timeoutMs: 5000, metadataOnly: true});
        const session = metadata.session;
        if (session.id !== sessionId || typeof session.createdAt !== 'number' || !session.historyRevision || session.activeTurnId
            || !['idle', 'notLoaded', null].includes(session.status))
            throw new Error('TWIN_DIGEST_UNAVAILABLE');
        const nativeIdentity = JSON.stringify([projectId, profileId, sessionId, root.serverId, root.serverProjectId, session.createdAt, maxRounds]);
        const cursor = sha256HexSync(JSON.stringify([nativeIdentity, metadata.revision]));
        if (cursor === previousCursor) return {text: '', hash: '', nativeIdentity, cursor, scannedRounds: 0, historyBytes: 0, contextBytes: 0};
        const digest = await client.digest(profileId, sessionId, {timeoutMs: 5000, expectedRevision: metadata.revision});
        if (digest.revision !== metadata.revision || digest.session.historyRevision !== session.historyRevision) throw new Error('TWIN_SOURCE_CHANGED');
        if (!digest.scan || digest.omittedUnclassified) throw new Error('TWIN_DIGEST_UNAVAILABLE');
        const turns = [...new Set(digest.messages.map(item => item.turnId))];
        if (turns.some(turn => !turn)) throw new Error('TWIN_HISTORY_INCOMPLETE');
        const selected = new Set(turns.slice(-maxRounds));
        const messages = digest.messages.filter(item => selected.has(item.turnId));
        const text = messages.length ? JSON.stringify(messages) : '';
        if (new TextEncoder().encode(text).length > TWIN_MANAGED_SOURCE_MAX_BYTES) throw new Error('TWIN_SOURCE_LIMIT');
        const after = await client.digest(profileId, sessionId, {timeoutMs: 5000, metadataOnly: true, expectedRevision: digest.revision});
        const current = mounts?.list(projectId).find(mount => mount.at === '/');
        if (after.revision !== digest.revision || after.session.historyRevision !== session.historyRevision || after.session.createdAt !== session.createdAt
            || after.session.activeTurnId || !['idle', 'notLoaded', null].includes(after.session.status) || current?.connectionId !== root.connectionId
            || current?.serverId !== root.serverId || current?.serverProjectId !== root.serverProjectId) throw new Error('TWIN_SOURCE_CHANGED');
        return {text, hash: sha256HexSync(text), nativeIdentity, cursor,
            scannedRounds: turns.length, hasOlder: turns.length > maxRounds || !!digest.nextCursor,
            historyBytes: digest.scan.historyBytes, contextBytes: digest.scan.contextBytes};
    } finally {await client.close();}
}
function parseTarget(target: string): [string, string, string] {
    const value: unknown = JSON.parse(target);
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'string' || !item)) throw new Error('TWIN_INVALID_SOURCE');
    return value as [string, string, string];
}
export function publicHarnessText(history: HarnessHistory): string {
    if (history.turns === null) throw new Error('TWIN_HISTORY_INCOMPLETE');
    return JSON.stringify(history.turns.flatMap(turn => {
        const row = turn as { id?: string; items?: Array<{ type?: string; id?: string; text?: string; content?: unknown }> };
        return (row.items ?? []).filter(item => ['userMessage', 'agentMessage'].includes(item.type ?? '')).map(item => ({
            id: item.id, turn: row.id, role: item.type === 'userMessage' ? 'user' : 'assistant',
            content: typeof item.text === 'string' ? item.text : visibleText(item.content),
        }));
    }));
}
function visibleText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(item => item && ['text', 'input_text', 'output_text'].includes(item.type) && typeof item.text === 'string').map(item => item.text).join('\n');
}

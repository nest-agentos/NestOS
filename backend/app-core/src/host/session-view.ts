import {randomUUID} from '@nestos/common';
import {sessionOpenMetrics} from './session-open-metrics';
import { FSError, type FileSystemContextOwner } from '@nestos/vfs-core';
import { SessionCommand, type SessionSnapshot } from '@nestos/llm-session/contracts';
import type { LocalApplicationServices, SessionEditorInitialData, SessionOpenView } from '@nestos/app-contracts/services';

/** Preparation may fail without replacing the editor's current binding. */
export async function openSessionView(services: LocalApplicationServices, sessionId: string): Promise<SessionOpenView> {
    const measure = sessionOpenMetrics(sessionId, randomUUID());
    await measure('execution.prepare', async () => services.prepareSession?.(sessionId));
    const conversation = await measure('conversation.acquire', async () => services.acquireConversation?.(sessionId));
    try { return await prepareSessionView(services, sessionId, measure, conversation); }
    catch (error) { await conversation?.dispose(); throw error; }
}

async function prepareSessionView(services: LocalApplicationServices, sessionId: string, measure: ReturnType<typeof sessionOpenMetrics>, conversation?: { dispose(): Promise<void> }): Promise<SessionOpenView> {
    const manifest = await measure('manifest.read', () => services.sessionRepository.getManifest(sessionId));
    const [project, fixed] = await Promise.all([
        measure('project.resolve', async () => services.projects?.forFolder(manifest.folder)), measure('workspace.fixed', async () => services.directoryMounts?.fixedWorkspace(sessionId)),
    ]);
    const owner = await measure('files.acquire', () => services.sessionFiles.acquireFiles(sessionId));
    const owned = { context: owner.context, release: async () => { try { await owner.release(); } finally { await conversation?.dispose(); } } };
    return { manifest, project, workspaceReadOnly: fixed !== undefined, context: owner.context, ...activationLease(services, sessionId, owned) };
}

function activationLease(services: LocalApplicationServices, sessionId: string, owner: FileSystemContextOwner): Pick<SessionOpenView, 'activate' | 'dispose'> {
    let closed = false;
    const activations = new Set<Promise<SessionEditorInitialData>>();
    return {
        activate: async branch => {
            if (closed) throw new FSError('EIO', 'Session view is closed');
            const pending = sessionOpenMetrics(sessionId, randomUUID())('editor.activate', () => activateSession(services, sessionId, branch)); activations.add(pending);
            try {
                const initial = await pending;
                if (closed) throw new FSError('EIO', 'Session view is closed');
                return initial;
            } finally { activations.delete(pending); }
        },
        dispose: async () => { closed = true; await Promise.allSettled(activations); await owner.release(); },
    };
}

/** Binding is deferred until the previous editor has saved and released its binding. */
async function activateSession(services: LocalApplicationServices, sessionId: string, branch?: string): Promise<SessionEditorInitialData> {
    let snapshot = await services.commandBus.execute<SessionSnapshot>(SessionCommand.Bind, { sessionId });
    if (branch !== undefined && snapshot.view?.manifest.currentBranch !== branch) {
        await services.commandBus.execute('vcs.branch.switch', { branchName: branch });
        snapshot = await services.commandBus.execute<SessionSnapshot>(SessionCommand.GetSnapshot);
    }
    const loaded = snapshot.view ?? (services.sessionRepository.getLoadState
        ? await services.sessionRepository.getLoadState(sessionId)
        : { manifest: await services.sessionRepository.getManifest(sessionId),
            settings: await services.commandBus.execute<SessionEditorInitialData['settings']>(SessionCommand.GetSettings) });
    return { sessionId, snapshot, ...loaded, title: loaded.manifest.title };
}

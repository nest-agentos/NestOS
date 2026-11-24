import {FSError} from '@nestos/vfs-core';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {PreparedConversation, ProjectConversationPort, ProjectFolder, ProjectService} from '@nestos/app-contracts/services';

const log = createModuleLogger('conversation-workbench');
/** Opening existing history never adopts, sends, responds or creates a Session. */
export async function prepareConversation(projects: ProjectService, resourceId: string, resolvedProject?: ProjectFolder | null): Promise<PreparedConversation> {
    const started = performance.now(), operationId = randomUUID(), target = resolveBrowserTarget(resourceId);
    if (target.kind !== 'remote' || !target.profileId || !target.nativeSessionId) throw new FSError('EINVAL', 'Existing native conversation required');
    const project = resolvedProject === undefined ? await projects.forFolder(target.folder) : resolvedProject;
    if (!project || project.path !== target.folder) throw Object.assign(new FSError('ENOENT', 'Conversation project missing'), {reason: 'REMOTE_PROJECT_MISSING'});
    if (!projects.remoteMounts) throw new FSError('ECAPABILITY', 'Remote conversations unavailable');
    let conversation: ProjectConversationPort | undefined, stage = 'binding';
    try {
        conversation = await projects.remoteMounts.projectConversation(project.project.id, target.profileId, target.nativeSessionId, {timeoutMs: 3000}, target.archived);
        stage = 'snapshot';
        const [snapshot, draft] = await Promise.all([conversation.read({includeUsage: false}), conversation.readComposerDraft?.()]);
        log.info('conversation.open', {operation: 'workbench.conversation', operationId, stage: 'prepare', result: 'success',
            messageCount: snapshot.messages.length, durationMs: Math.round(performance.now() - started)});
        return {resourceId, project, conversation, draft, issues: {}, deferredMetadata: true};
    } catch (error) {
        log.warn('conversation.open', {operation: 'workbench.conversation', operationId, stage, result: 'failure', code: safeCode(error), durationMs: Math.round(performance.now() - started)});
        if (conversation) await Promise.allSettled([conversation.close()]);
        throw error;
    }
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONVERSATION_PREPARE_FAILED';
}

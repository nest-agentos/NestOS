import {FSError} from '@nestos/vfs-core';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {PreparedConversation, ProjectConversationPort, ProjectFolder, ProjectService} from '@nestos/app-contracts/services';

const log = createModuleLogger('conversation-workbench');
/** Opening existing history never adopts, sends, responds or creates a Session. */
export async function prepareConversation(projects: ProjectService, resourceId: string, resolvedProject?: ProjectFolder | null, prepareInput?: boolean): Promise<PreparedConversation> {
    const started = performance.now(), operationId = randomUUID(), target = resolveBrowserTarget(resourceId);
    if (target.kind !== 'remote' || !target.profileId || !target.nativeSessionId) throw new FSError('EINVAL', 'Existing native conversation required');
    const project = resolvedProject === undefined ? await projects.forFolder(target.folder) : resolvedProject;
    if (!project || project.path !== target.folder) throw Object.assign(new FSError('ENOENT', 'Conversation project missing'), {reason: 'REMOTE_PROJECT_MISSING'});
    if (!projects.remoteMounts) throw new FSError('ECAPABILITY', 'Remote conversations unavailable');
    let conversation: ProjectConversationPort | undefined, stage = 'binding';
    try {
        conversation = await projects.remoteMounts.projectConversation(project.project.id, target.profileId, target.nativeSessionId, {timeoutMs: 3000}, target.archived);
        const boundAt = performance.now();
        stage = 'snapshot';
        const deferredMetadata = !target.archived && (prepareInput === undefined || target.profileId === 'agy' && prepareInput);
        const composer = prepareInput && !deferredMetadata && !target.archived ? prepareComposer(conversation, operationId) : undefined;
        const [snapshot, draft, input] = await Promise.all([conversation.read({includeUsage: false}),
            conversation.readComposerDraft?.(), composer]);
        log.info('conversation.open', {operation: 'workbench.conversation', operationId, stage: 'prepare', result: 'success',
            messageCount: snapshot.messages.length, bindingMs: Math.round(boundAt - started), snapshotMs: Math.round(performance.now() - boundAt),
            durationMs: Math.round(performance.now() - started)});
        return {resourceId, project, conversation, draft, issues: {}, deferredMetadata, ...input};
    } catch (error) {
        log.warn('conversation.open', {operation: 'workbench.conversation', operationId, stage, result: 'failure', code: safeCode(error), durationMs: Math.round(performance.now() - started)});
        if (conversation) await Promise.allSettled([conversation.close()]);
        throw error;
    }
}

async function prepareComposer(conversation: ProjectConversationPort, operationId: string): Promise<Pick<PreparedConversation, 'models' | 'commands' | 'issues' | 'deferredMetadata'>> {
    const started = performance.now(), timeoutMs = 1000, snapshot = conversation.snapshot();
    const [models, commands] = await Promise.allSettled([
        snapshot.supportsModels ? conversation.models?.({timeoutMs}) : undefined,
        snapshot.supportsSlashCommands ? conversation.commands?.({timeoutMs}) : undefined,
    ]);
    const issues = {models: models.status === 'rejected' ? safeCode(models.reason) : undefined,
        commands: commands.status === 'rejected' ? safeCode(commands.reason) : undefined};
    const deferredMetadata = Boolean(issues.models || issues.commands);
    log.info('conversation.composer', {operation: 'workbench.conversation', operationId, stage: 'composer',
        result: deferredMetadata ? 'partial' : 'success', ...issues, durationMs: Math.round(performance.now() - started)});
    return {issues, deferredMetadata,
        models: models.status === 'fulfilled' ? models.value : undefined,
        commands: commands.status === 'fulfilled' ? commands.value : undefined};
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONVERSATION_PREPARE_FAILED';
}

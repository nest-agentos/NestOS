import {FSError} from '@nestos/vfs-core';
import {resolveBrowserTarget} from '@nestos/app-contracts';
import {createModuleLogger, randomUUID} from '@nestos/common';
import type {PreparedConversation, ProjectService} from '@nestos/app-contracts/services';

const log = createModuleLogger('conversation-workbench');
/** Opening existing history never adopts, sends, responds or creates a Session. */
export async function prepareConversation(projects: ProjectService, resourceId: string): Promise<PreparedConversation> {
    const started = performance.now(), operationId = randomUUID(), target = resolveBrowserTarget(resourceId);
    if (target.kind !== 'remote' || !target.profileId || !target.nativeSessionId) throw new FSError('EINVAL', 'Existing native conversation required');
    const project = await projects.forFolder(target.folder);
    if (!project || project.path !== target.folder) throw Object.assign(new FSError('ENOENT', 'Conversation project missing'), {reason: 'REMOTE_PROJECT_MISSING'});
    if (!projects.remoteMounts) throw new FSError('ECAPABILITY', 'Remote conversations unavailable');
    const conversation = await projects.remoteMounts.projectConversation(project.project.id, target.profileId, target.nativeSessionId, {timeoutMs: 3000}, target.archived);
    try {
        const [, draft] = await Promise.all([conversation.read(), conversation.readComposerDraft?.()]);
        const issues: PreparedConversation['issues'] = {}, state = conversation.snapshot();
        const [models, commands] = await Promise.all([
            optional('models', state.supportsModels ? conversation.models?.() : undefined, issues, operationId),
            optional('commands', state.supportsSlashCommands ? conversation.commands?.() : undefined, issues, operationId),
            optional('metrics', state.supportsMetrics ? conversation.refreshMetrics?.() : undefined, issues, operationId),
        ]);
        log.info('conversation.open', {operation: 'workbench.conversation', operationId, stage: 'prepare', result: 'success', durationMs: Math.round(performance.now() - started)});
        return {resourceId, project, conversation, draft, models, commands, issues};
    } catch (error) {
        await conversation.close();
        log.warn('conversation.open', {operation: 'workbench.conversation', operationId, stage: 'prepare', result: 'failure', code: safeCode(error), durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}
async function optional<T>(stage: keyof PreparedConversation['issues'], work: Promise<T> | undefined, issues: PreparedConversation['issues'], operationId: string): Promise<T | undefined> {
    if (!work) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    try {return await Promise.race([work, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(Object.assign(new Error('Metadata preparation timed out'), {code: 'WORKBENCH_METADATA_TIMEOUT'})), 1500);})]);}
    catch (error) {
        issues[stage] = safeCode(error);
        log.warn('conversation.metadata', {operation: 'workbench.conversation', operationId, stage, result: 'failure', code: issues[stage], durationMs: Math.round(performance.now() - started)});
    } finally {clearTimeout(timer);}
}
function safeCode(error: unknown): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'CONVERSATION_PREPARE_FAILED';
}

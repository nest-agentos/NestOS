import {SessionCommand, type ISessionRepository, type SessionInstructionQueue} from '@nestos/llm-session/contracts';
import type {ConversationContexts} from '../runtime/conversation-contexts';
import type {ControlJournal, SubmissionControlRequest, SubmissionControlState} from './submission-control';
import {failure} from './prompt-bundle';
interface Options {
    contexts: Pick<ConversationContexts, 'open'>; repository: Pick<ISessionRepository, 'readDocument' | 'getManifest'>;
    ensureWritable?(sessionId: string): Promise<boolean>;
}
/** Remove only the original pending instruction; dispatching or uncertain work still needs its round. */
export async function cancelQueuedSubmission(options: Options, input: SubmissionControlRequest, journal: ControlJournal): Promise<SubmissionControlState> {
    if (input.action !== 'cancel') throw failure('SUBMISSION_RECEIPT_UNKNOWN');
    if (!await options.repository.getManifest(input.sessionId)) throw failure('SESSION_NOT_FOUND');
    const key = 'submission-queue-cancel:' + JSON.stringify([input.sessionId,input.submissionId,input.requestId]);
    const saved = await journal.get<{seen: boolean}>(key);
    const lease = await options.contexts.open(input.sessionId);
    try {
        const queue = await lease.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        const item = queue.items.find(row => row.id === input.submissionId);
        if (await options.repository.readDocument(input.sessionId, 'round-' + input.submissionId + '.json')) return 'accepted';
        if (!item) return saved?.seen ? 'cancelled' : 'unknown';
        if (!['pending','failed'].includes(item.state)) return 'unknown';
        if (options.ensureWritable && !await options.ensureWritable(input.sessionId)) throw failure('SESSION_WRITER_UNAVAILABLE');
        await journal.update(key, old => old ?? {seen:true});
        await lease.commandBus.execute(SessionCommand.EditInstructionQueue, {action:'remove',id:item.id,expectedRevision:queue.revision});
        return 'cancelled';
    } finally {await lease.dispose();}
}

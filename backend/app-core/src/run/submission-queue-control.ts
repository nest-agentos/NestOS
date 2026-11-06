import {SessionCommand, type ISessionRepository, type SessionInstructionQueue} from '@nestos/llm-session/contracts';
import type {ConversationContexts} from '../runtime/conversation-contexts';
import type {SubmissionControlRequest, SubmissionControlState} from './submission-control';
import {failure} from './prompt-bundle';
interface Options {
    contexts: Pick<ConversationContexts, 'open'>; repository: Pick<ISessionRepository, 'readDocument' | 'getManifest'>;
    ensureWritable?(sessionId: string): Promise<boolean>;
}
/** Fence unadmitted or pending input durably; uncertain admitted work still needs its round. */
export async function cancelQueuedSubmission(options: Options, input: SubmissionControlRequest): Promise<SubmissionControlState> {
    if (input.action !== 'cancel') throw failure('SUBMISSION_RECEIPT_UNKNOWN');
    if (!await options.repository.getManifest(input.sessionId)) throw failure('SESSION_NOT_FOUND');
    const lease = await options.contexts.open(input.sessionId);
    try {
        const queue = await lease.commandBus.execute<SessionInstructionQueue>(SessionCommand.GetInstructionQueue);
        const item = queue.items.find(row => row.id === input.submissionId);
        if (await options.repository.readDocument(input.sessionId, 'round-' + input.submissionId + '.json')) return 'accepted';
        if (queue.cancelledIds?.includes(input.submissionId)) return 'cancelled';
        if (item && !['pending','failed'].includes(item.state)) return 'unknown';
        if (options.ensureWritable && !await options.ensureWritable(input.sessionId)) throw failure('SESSION_WRITER_UNAVAILABLE');
        try {
            const receipt = await lease.commandBus.execute<SessionInstructionQueue>(SessionCommand.EditInstructionQueue,
                {action:'cancel',id:input.submissionId,expectedRevision:queue.revision});
            if (!receipt.cancelledIds?.includes(input.submissionId)) throw failure('SUBMISSION_CANCEL_UNCONFIRMED');
        } catch (error) {
            if ((error as {code?: string})?.code === 'QUEUE_EXECUTION_UNSETTLED') return 'unknown';
            throw error;
        }
        return 'cancelled';
    } finally {await lease.dispose();}
}

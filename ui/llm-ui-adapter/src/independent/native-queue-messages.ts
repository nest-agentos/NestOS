import {formatDateTime} from '@nestos/ui-common';
import type {ConversationInstructionQueue, ConversationSnapshot as NativeSnapshot} from '../contracts';
import {getLocale, t} from '@nestos/common';
import type {ChatMessage, ConversationSnapshot, OperationLedger} from '@nestos/llm-ui';


/** Queue edits change previews, never the immutable submitted input or its receipt. */
export function nativeQueueMessages(state: NativeSnapshot, operations: OperationLedger, conversationId: string): ConversationSnapshot['operationMessages'] {
    const queue = state.instructionQueue;
    if (!queue) return;
    const accepted = new Set(queue.acceptedIds), submissions = new Map(queue.submissions?.map(item => [item.id, item]));
    return operations.getSnapshot().filter(record => record.conversationId === conversationId && accepted.has(record.context.operationId))
        .flatMap<NonNullable<ConversationSnapshot['operationMessages']>[number]>(record => {
            const operationId = record.context.operationId, item = queue.items.find(item => item.id === operationId);
            if (item) return [{operationId, message: queueMessage(item, queue)}];
            const sent = submissions.get(operationId);
            return sent?.turnId || sent?.commandId ? [] : [{operationId, message: null}];
        });
}

export function nativeQueueNotice(state: NativeSnapshot): {code: string; message: string} | undefined {
    const queue = state.instructionQueue;
    if (!queue?.recovery?.required) return;
    return {code: 'HARNESS_EXECUTION_RECOVERY_REQUIRED', message: recoverySummary(queue)};
}

function recoverySummary(queue: ConversationInstructionQueue): string {
    return t(queue.reason === 'execution-detached' ? 'session.instructions.reason.detached' : 'session.instructions.reason.recoveryRequired');
}

function queueMessage(item: ConversationInstructionQueue['items'][number], queue: ConversationInstructionQueue): ChatMessage {
    const failed = item.state === 'failed', recovery = !!queue.recovery?.required;
    return {id: `operation:${item.id}`, revision: queue.revision, role: 'user', state: failed ? 'failed' : 'pending', timestamp: item.createdAt,
        statusLabel: recovery ? t('session.instructions.recoveryRequired') : undefined,
        parts: [{id: 'text', kind: 'markdown', text: item.text},
            {id: 'status', kind: 'tool', name: recovery ? t('session.instructions.recoveryRequired') : item.state === 'dispatching' ? t(item.acceptedAt ? 'session.instructions.acceptedAt' : 'session.instructions.dispatchedAt') : t(`session.instructions.${item.state}`),
                summary: recovery ? recoverySummary(queue) : queueSummary(item),
                state: failed ? 'failed' : recovery ? 'unknown' : item.state === 'dispatching' ? 'running' : 'pending'},
            ...(item.files.length ? [{id: 'files', kind: 'json' as const, label: t('session.instructions.attachments'), value: item.files.map(file => file.name)}] : [])]};
}

function queueSummary(item: ConversationInstructionQueue['items'][number]): string {
    if (item.error) return item.error === 'HARNESS_SESSION_BUSY' ? t('chat.submission.occupied') : item.error;
    const accepted = new Date(item.acceptedAt ?? NaN);
    if (Number.isFinite(accepted.getTime()) && accepted.getTime() > 0)
        return `${t('session.instructions.acceptedAt')} · ${formatDateTime(accepted,getLocale(), {hour12: false})}`;
    return item.state === 'pending' ? t('session.instructions.hint') : '';
}

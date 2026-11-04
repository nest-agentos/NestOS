import type {ChatMessage, MessagePart} from '@nestos/llm-ui';

/** Keep execution outcomes visible without changing backend execution facts. */
export function messageState(status?: string): ChatMessage['state'] {
    if (status === 'failed' || status === 'error') return 'failed';
    if (status === 'cancelled' || status === 'aborted' || status === 'interrupted') return 'cancelled';
    if (status === 'running' || status === 'streaming' || status === 'inProgress') return 'streaming';
    if (['pending', 'queued', 'paused', 'waiting', 'waiting-input', 'waiting-approval', 'waiting_input'].includes(status ?? '')) return 'pending';
    return 'complete';
}

export function toolState(status?: string): Extract<MessagePart, {kind: 'tool'}>['state'] {
    if (['success', 'succeeded', 'complete', 'completed'].includes(status ?? '')) return 'succeeded';
    if (!status || !['failed', 'error', 'cancelled', 'aborted', 'interrupted', 'inProgress', 'running', 'streaming', 'pending', 'queued', 'paused', 'waiting', 'waiting-input', 'waiting-approval', 'waiting_input'].includes(status)) return 'unknown';
    const state = messageState(status);
    return state === 'streaming' ? 'running' : state === 'complete' ? 'unknown' : state;
}

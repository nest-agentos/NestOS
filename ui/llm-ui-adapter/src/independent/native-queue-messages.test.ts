import {expect, it} from 'vitest';
import {createOperationLedger} from '@nestos/llm-ui';
import type {ConversationSnapshot} from '../contracts';
import {nativeQueueMessages, nativeQueueNotice} from './native-queue-messages';

it('explains stalled accepted work and pending messages without claiming a tool is running', async () => {
    const operations = createOperationLedger();
    for (const id of ['old', 'next']) {
        await operations.register({context: {operationId: id, viewId: 'view'}, conversationId: 'native', kind: 'send', input: {text: id}, status: 'submitting'});
        await operations.settle({status: 'accepted', operationId: id});
    }
    const state: ConversationSnapshot = {title: 'Native', messages: [], requests: [], canSend: false, canInterrupt: false,
        canRespond: false, pending: false, disconnected: false, gap: false,
        instructionQueue: {revision: 7, paused: false, acceptedIds: ['old', 'next'], reason: 'execution-detached',
        recovery: {id: 'old', required: true}, items: [
            {id: 'old', text: 'Old input', state: 'dispatching', createdAt: 1, files: []}, {id: 'next', text: 'Next input', state: 'pending', createdAt: 2, files: []},
        ]}};
    expect(nativeQueueNotice(state)).toMatchObject({code: 'HARNESS_EXECUTION_RECOVERY_REQUIRED'});
    const messages = nativeQueueMessages(state, operations, 'native')!;
    for (const row of messages) {
        expect(row.message!.state).toBe('pending'); expect(row.message!.statusLabel).toBeTruthy();
        expect(row.message!.parts).toContainEqual(expect.objectContaining({kind: 'tool', state: 'unknown', summary: nativeQueueNotice(state)!.message}));
    }
    state.instructionQueue!.recovery = undefined; state.instructionQueue!.reason = 'active-turn';
    expect(nativeQueueNotice(state)).toBeUndefined();
    expect(nativeQueueMessages(state, operations, 'native')![0].message!.parts).toContainEqual(expect.objectContaining({kind: 'tool', state: 'running'}));
});

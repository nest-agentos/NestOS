// @vitest-environment jsdom
import {expect, it} from 'vitest';
import {createChatView, createOperationLedger} from '@nestos/llm-ui';
import type {ConversationControls, ConversationSnapshot} from '../contracts';
import {createNativeChatBinding} from './native';
import {nativeInputPolicy} from './native-input-policy';

it('keeps the composer usable after durable queue acceptance while execution and its transport remain pending', async () => {
    let state: ConversationSnapshot = {title: 'Native', sessionId: 's', messages: [], requests: [], canSend: false,
        canQueue: true, active: true, canInterrupt: false, canRespond: false, pending: false, disconnected: false, gap: false};
    const listeners = new Set<() => void>(); let operationId = '', calls = 0;
    let finish!: (state: ConversationSnapshot) => void;
    const reply = new Promise<ConversationSnapshot>(resolve => {finish = resolve;});
    const controls = {read: async () => state, refresh: async () => state, snapshot: () => state,
        subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
        enqueue: async (_text: string, _files: unknown, _selection: unknown, id: string) => {calls++; operationId = id; return reply;},
    } as unknown as ConversationControls;
    const binding = await createNativeChatBinding({conversationId: 'native', controls, operations: createOperationLedger(),
        reconcile: async id => ({status: 'unknown', operationId: id, message: 'Admission unconfirmed'})});
    const root = document.createElement('div'); document.body.append(root);
    const view = await createChatView(root, {...binding, resolveSubmissionMode: () => binding.resolveSubmissionMode()});
    try {
        const input = root.querySelector('textarea')!, send = root.querySelector<HTMLButtonElement>('button[type=submit]')!;
        const type = (text: string) => {input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));};
        const emit = (id: string) => {state = {...state, instructionQueue: {revision: 1, paused: false, acceptedIds: [id], items: []}};
            listeners.forEach(listener => listener());};
        type('First'); expect(send.disabled).toBe(false);
        const sending = view.submit();
        await until(() => calls === 1); type('Next'); expect(send.disabled).toBe(true);
        emit('different-operation'); await Promise.resolve(); expect(send.disabled).toBe(true);
        emit(operationId); await sending;
        expect(input.value).toBe('Next'); expect(send.disabled).toBe(false);
        expect(calls).toBe(1); expect(state.active).toBe(true); expect(binding.source.getSnapshot().submissionMode).toBe('queue');
    } finally {finish(state); await view.destroy(); binding.dispose(); root.remove();}
});

it('uses one route for durable admission and display without confusing execution with input availability', () => {
    const state = {canQueue: true, canSend: true, pending: false, active: false} as ConversationSnapshot;
    const controls = {enqueue: async () => state, steer: async () => state} as unknown as ConversationControls;
    expect(nativeInputPolicy(state, controls)).toEqual({route: 'queue', mode: 'send'});
    expect(nativeInputPolicy({...state, active: true, canSend: false, pending: true}, controls)).toEqual({route: 'queue', mode: 'queue'});
    expect(nativeInputPolicy({...state, canQueue: false, pending: true}, controls).route).toBe('blocked');
    expect(nativeInputPolicy({...state, canSteer: true}, controls).route).toBe('queue');
    const steering = {...state, canSteer: true, observation: {activeTurnId: 'turn'}} as ConversationSnapshot;
    expect(nativeInputPolicy(steering, controls)).toEqual({route: 'steer', mode: 'steer', turnId: 'turn'});
    expect(nativeInputPolicy(steering, controls, false).route).toBe('queue');
});

async function until(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0));}
    throw new Error('INPUT_ADMISSION_TIMEOUT');
}

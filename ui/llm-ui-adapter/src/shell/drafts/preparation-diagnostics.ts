import {createModuleLogger, randomUUID} from '@nestos/common';
const log = createModuleLogger('chat-draft-editor');
/** Only identity, counts and allowlisted failure metadata leave the composer. */
export function draftPreparationDiagnostics(conversationId: string, textChars: number, attachmentCount: number) {
    const operationId = randomUUID(), started = Date.now(); let stage = 'draft.flush';
    const report = (result: string, extra: Record<string, unknown> = {}) => log.debug('chat.draft.prepare',
        {operationId,conversationId,stage,result,durationMs:Date.now()-started,...extra});
    report('started',{textChars,attachmentCount});
    return {
        step(next: string) {stage=next;if(next==='complete')report('success');},
        fail(error: unknown) {
            const detail = error as {code?:unknown;clientRequestId?:unknown};
            const code = typeof detail?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(detail.code) ? detail.code : 'SEND_PREPARATION_FAILED';
            const clientRequestId = typeof detail?.clientRequestId === 'string' && /^[a-f0-9-]{36}$/.test(detail.clientRequestId) ? detail.clientRequestId : undefined;
            log.warn('chat.draft.prepare',{operationId,conversationId,stage,result:'failure',code,clientRequestId,durationMs:Date.now()-started});
        },
    };
}

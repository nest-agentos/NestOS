import {NATIVE_SESSION_RECOVERY_ENDPOINT, NATIVE_SESSION_RECOVERY_VERSION} from '@nestos/app-contracts';
import type {NativeSessionRecoveryPort, NativeSessionRecoveryTarget, NativeSessionRecoveryResult, NativeSessionRecoveryState} from '@nestos/app-contracts/services';
import {FSError, type FSErrorCode} from '@nestos/vfs-core';
import {MAX_BODY_BYTES} from '../rpc/protocol';
/** This authenticated business client has no view IDs, capabilities, bootstrap or SSE. */
export function createSessionRecoveryClient(fetcher: typeof fetch, endpoint = NATIVE_SESSION_RECOVERY_ENDPOINT): NativeSessionRecoveryPort {
    const request = async (body: object, operationId?: string) => {
        let response: Response;
        try {response = await fetcher(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({version: NATIVE_SESSION_RECOVERY_VERSION, ...body})});}
        catch {throw Object.assign(new FSError('EIO', 'Session recovery connection failed; reconcile the same operation ID'), {outcome: 'unknown', operationId});}
        const value = await readBody(response) as {error?: {code?: string; message?: string; remoteCode?: string; outcome?: string}};
        if (!response.ok) {
            const code = value.error?.code, known = ['EINVAL','EACCES','ECONFLICT','EBUSY','ECAPABILITY','EFBIG','EIO','ENOENT'];
            throw Object.assign(new FSError(known.includes(code ?? '') ? code as FSErrorCode : 'EIO', value.error?.message ?? 'Session recovery failed'),
                {remoteCode: value.error?.remoteCode, outcome: value.error?.outcome ?? 'unknown', operationId});
        }
        return value;
    };
    return {
        inspect: async target => validateState(await request({action: 'inspect', target}) as NativeSessionRecoveryState, target),
        recover: async input => {
            const result = await request({action: 'recover', request: input}, input.operationId) as NativeSessionRecoveryResult;
            if (result.operationId !== input.operationId || !['recovered','no-longer-blocked'].includes(result.outcome) || typeof result.duplicate !== 'boolean')
                throw Object.assign(new FSError('EIO', 'Invalid session recovery receipt'), {outcome: 'unknown', operationId: input.operationId});
            return {...result, state: validateState(result.state, input)};
        },
    };
}
function validateState(value: NativeSessionRecoveryState, target: NativeSessionRecoveryTarget): NativeSessionRecoveryState {
    if (!value || value.sessionId !== target.sessionId || value.instructionQueue && (!Number.isSafeInteger(value.instructionQueue.revision)
        || !Array.isArray(value.instructionQueue.items) || value.instructionQueue.items.length > 100)) throw new FSError('EIO', 'Invalid session recovery state');
    return value;
}
async function readBody(response: Response): Promise<unknown> {
    const reader = response.body?.getReader(); if (!reader) throw new FSError('EIO', 'Missing session recovery response');
    const chunks: Uint8Array[] = []; let length = 0;
    try {for (;;) {const next = await reader.read(); if (next.done) break; length += next.value.byteLength;
        if (length > MAX_BODY_BYTES) {await reader.cancel(); throw new FSError('EFBIG', 'Session recovery response is too large');} chunks.push(next.value);}}
    finally {reader.releaseLock();}
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
    try {return JSON.parse(new TextDecoder().decode(bytes));} catch {throw new FSError('EIO', 'Invalid session recovery response');}
}

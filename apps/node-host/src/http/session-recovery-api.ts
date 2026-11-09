import type {IncomingMessage, ServerResponse} from 'node:http';
import type {NativeSessionRecoveryPort, NativeSessionRecoveryRequest, NativeSessionRecoveryTarget} from '@nestos/app-contracts/services';
import {NATIVE_SESSION_RECOVERY_ENDPOINT, NATIVE_SESSION_RECOVERY_VERSION} from '@nestos/app-contracts';
import {diagnosticContext} from '@nestos/common';
import {FSError} from '@nestos/vfs-core';
import type {AuditPort} from '../logging/audit-log';
import {readBytes, json, sendError} from './http-response';
export class SessionRecoveryApi {
    constructor(private readonly service: Promise<NativeSessionRecoveryPort>, private readonly audit?: AuditPort) {}
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const started = Date.now(); let operationId: string | undefined, stage = 'validate';
        try {
            const body = await bodyOf(request); operationId = typeof body.request?.operationId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(body.request.operationId) ? body.request.operationId : undefined;
            stage = body.action; const service = await this.service;
            const result = body.action === 'inspect' ? await service.inspect(body.target!) : await service.recover(body.request!);
            json(response, 200, result);
            this.audit?.write({...diagnosticContext(), event: 'session.recovery', operationId, stage, result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            this.audit?.write({...diagnosticContext(), event: 'session.recovery', operationId, stage, result: 'failure', code: error instanceof FSError ? error.code : 'EIO', durationMs: Date.now() - started});
            sendError(response, error);
        }
    }
}
async function bodyOf(request: IncomingMessage): Promise<{action: 'inspect' | 'recover'; target?: NativeSessionRecoveryTarget; request?: NativeSessionRecoveryRequest}> {
    if (request.method !== 'POST') throw new FSError('EINVAL', 'Session recovery requires POST');
    if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new FSError('EINVAL', 'Session recovery requires JSON');
    const bytes = await readBytes(request); let body: Record<string, unknown>;
    try {body = JSON.parse(bytes.toString('utf8'));} catch {throw new FSError('EINVAL', 'Malformed session recovery request');}
    validateEnvelope(body);
    const payload = body.action === 'inspect' ? body.target : body.request;
    const keys = body.action === 'inspect' ? ['projectId','profileId','sessionId'] : ['projectId','profileId','sessionId','operationId','instructionId','expectedRevision'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !keys.includes(key))) throw new FSError('EINVAL', 'Invalid session recovery fields');
    return body as unknown as Awaited<ReturnType<typeof bodyOf>>;
}
function validateEnvelope(body: Record<string, unknown>): void {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new FSError('EINVAL', 'Invalid session recovery protocol');
    if (body.version !== NATIVE_SESSION_RECOVERY_VERSION || !['inspect','recover'].includes(String(body.action))) throw new FSError('EINVAL', 'Invalid session recovery protocol');
    const keys = body.action === 'inspect' ? ['version','action','target'] : ['version','action','request'];
    if (Object.keys(body).some(key => !keys.includes(key))) throw new FSError('EINVAL', 'Invalid session recovery protocol fields');
}

export function isSessionRecoveryRequest(request: IncomingMessage): boolean {
    return new URL(request.url ?? '/', 'https://localhost').pathname === NATIVE_SESSION_RECOVERY_ENDPOINT;
}

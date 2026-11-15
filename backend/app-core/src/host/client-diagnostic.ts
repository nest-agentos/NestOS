import {diagnosticContext} from '@nestos/common';
import type {ClientDiagnostic} from '@nestos/app-contracts/services';

const identity = /^[a-zA-Z0-9_-]{1,160}$/;
const label = /^[a-z][a-z0-9.-]{0,63}$/;
const code = /^[A-Z][A-Z0-9_]{0,79}$/;
const tokens = {operation: label, operationId: identity, sessionId: identity, stage: label, code, remoteCode: code, requestId: identity};
const required = new Set(['operation', 'operationId', 'stage', 'code']);
const allowed = new Set([...Object.keys(tokens), 'result', 'durationMs', 'http']);

/** Rebuild an allowlisted record before it reaches the host runtime log. */
export function reportClientDiagnostic(value: ClientDiagnostic): void {
    const record = value as unknown as Record<string, unknown>;
    if (!record || typeof record !== 'object' || Object.keys(record).some(key => !allowed.has(key)) || !validTokens(record) || !validOutcome(record) || !validHttp(value.http))
        throw Object.assign(new Error('Invalid client diagnostic metadata'), {code: 'CLIENT_DIAGNOSTIC_INVALID'});
    console.warn('[ClientDiagnostic]', {...diagnosticContext(), source: 'client', operation: value.operation, operationId: value.operationId,
        sessionId: value.sessionId, stage: value.stage, code: value.code, result: value.result, durationMs: value.durationMs,
        remoteCode: value.remoteCode, requestId: value.requestId, ...(value.http ? {http: {...value.http}} : {})});
}
function validHttp(value: ClientDiagnostic['http']): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object') return false;
    const patterns: Record<string, RegExp> = {
        browserSessionId: /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, traceId: /^[a-f0-9]{32}$/, spanId: /^[a-f0-9]{16}$/,
        method: /^(GET|POST|OTHER)$/, route: /^\/(api\/(application(?:\/events|\/files)?|health|identity)|resource)$/,
        rpcKind: /^(bootstrap|bootstrap-data|queries|bindings|call|callback|close|other)$/,
        rpcMethod: /^[A-Za-z][A-Za-z0-9_]{0,63}$/, responseType: /^(json|html|text|other)$/, errorKind: /^(abort|network|type|other)$/,
    };
    const limits: Record<string, [number, number]> = {occurredAt: [0, 8640000000000000], requestBytes: [0, 1024**3], contentLength: [0, 1024**3], status: [100, 599]};
    if (!['browserSessionId','traceId','spanId','occurredAt','method','route'].every(k => k in value)) return false;
    return Object.entries(value).every(([key, v]) => v === undefined ? Object.hasOwn(patterns,key) || Object.hasOwn(limits,key) || key === 'online'
        : Object.hasOwn(patterns,key) ? typeof v === 'string' && patterns[key].test(v)
        : Object.hasOwn(limits,key) ? typeof v === 'number' && Number.isSafeInteger(v) && v >= limits[key][0] && v <= limits[key][1]
        : key === 'online' && typeof v === 'boolean');
}
function validTokens(record: Record<string, unknown>): boolean {
    return Object.entries(tokens).every(([key, pattern]) => record[key] === undefined ? !required.has(key)
        : typeof record[key] === 'string' && pattern.test(record[key] as string));
}
function validOutcome(record: Record<string, unknown>): boolean {
    return (record.result === 'retrying' || record.result === 'failure') && typeof record.durationMs === 'number'
        && Number.isFinite(record.durationMs) && record.durationMs >= 0 && record.durationMs <= 86400000;
}

import {sha256HexSync} from '@nestos/common';
import {failure} from './prompt-bundle';
export interface ChannelRequest {id: string; scopeId: string; method: string; params: Record<string, unknown>}
export interface ChannelResponse {id: string; scopeId: string; requestDigest: string; status: 'ok' | 'error'; payload: unknown; error: {code: string} | null}
export interface ChannelEnvelope {request: ChannelRequest; requestDigest: string; response: ChannelResponse | null}
export interface ChannelReply {id: string; requestDigest: string; sha256: string}
/** RFC 8785 ordering and ECMAScript numbers must agree with the node's canonical encoder. */
export const channelDigest = (value: unknown): string => sha256HexSync(canonical(value));
function canonical(value: unknown): string {
    if (typeof value === 'number' && !Number.isFinite(value)) throw failure('CHANNEL_VALUE_INVALID');
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string,unknown>)[key])).join(',') + '}';
    const encoded=JSON.stringify(value);
    if(encoded===undefined)throw failure('CHANNEL_VALUE_INVALID');
    return encoded;
}
export function channelRequests(value: unknown, scopeId: string): ChannelEnvelope[] {
    const rows = (value as {requests?: ChannelEnvelope[]})?.requests;
    if (!Array.isArray(rows) || rows.length > 128) throw failure('CHANNEL_REQUEST_LIMIT');
    for (const row of rows) {
        const request = row?.request;
        if (!request || request.scopeId !== scopeId || !/^[\w-]{1,128}$/.test(request.id) || typeof request.method !== 'string'
            || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)
            || channelDigest(request) !== row.requestDigest) throw failure('CHANNEL_REQUEST_INVALID');
        if (row.response && (row.response.id !== request.id || row.response.scopeId !== scopeId || row.response.requestDigest !== row.requestDigest
            || !['ok', 'error'].includes(row.response.status))) throw failure('CHANNEL_RESPONSE_INVALID');
    }
    if (new Set(rows.map(row => row.request.id)).size !== rows.length) throw failure('CHANNEL_REQUEST_INVALID');
    return rows;
}

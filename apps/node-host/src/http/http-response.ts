import type { ServerResponse, IncomingMessage } from 'node:http';
import { FSError, type FSErrorCode } from '@nestos/vfs-core';
import { MAX_BODY_BYTES } from '@nestos/app-transport/rpc';
import { recordResponseQueued } from '../logging/audit-log';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createModuleLogger, randomUUID} from '@nestos/common';

const compress = promisify(gzip), log = createModuleLogger('http-response');

export async function readJson(request: IncomingMessage): Promise<{ method?: unknown; args?: unknown }> {
    const bytes = await readBytes(request);
    try {
        const value = JSON.parse(bytes.toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request');
        return value;
    } catch { throw new FSError('EINVAL', 'Malformed JSON request'); }
}
export async function readBytes(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
        const bytes = Buffer.from(chunk); size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP request is too large');
        chunks.push(bytes);
    }
    return Buffer.concat(chunks);
}
export function json(response: ServerResponse, status: number, payload: unknown): void {
    if (response.destroyed) return;
    writeJson(response, status, jsonBody(payload));
}
/** Bound the uncompressed response before negotiating transport compression. */
export async function compressedJson(response: ServerResponse, status: number, payload: unknown): Promise<void> {
    if (response.destroyed) return;
    const body = jsonBody(payload), encoding = response.req?.headers['accept-encoding'] ?? '';
    if (body.length < 4096 || !acceptsGzip(encoding)) {writeJson(response, status, body); return;}
    const operationId = String(response.getHeader('X-Request-ID') ?? randomUUID()), started = performance.now();
    try {
        const encoded = await compress(body, {level:1}), smaller = encoded.length < body.length;
        if (response.destroyed) return;
        writeJson(response, status, smaller ? encoded : body, smaller);
        log.debug('http.response', {operationId, stage:'compress', result:'success', bodyBytes:body.length,
            wireBytes:smaller ? encoded.length : body.length, durationMs:Math.round(performance.now()-started)});
    } catch (error) {
        const raw = (error as NodeJS.ErrnoException)?.code;
        const code = typeof raw === 'string' && /^[A-Z_0-9]{1,64}$/.test(raw) ? raw : 'HTTP_COMPRESSION_FAILED';
        log.warn('http.response', {operationId, stage:'compress', result:'failure', code, bodyBytes:body.length, durationMs:Math.round(performance.now()-started)});
        throw new FSError('EIO', 'HTTP response compression failed');
    }
}
function jsonBody(payload: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(payload));
    if (body.length > MAX_BODY_BYTES) throw new FSError('EFBIG', 'HTTP response is too large; use smaller pages or file ranges');
    return body;
}
function writeJson(response: ServerResponse, status: number, body: Buffer, encoded = false): void {
    response.writeHead(status, {'Content-Type':'application/json', 'Cache-Control':'no-store', 'Content-Length':body.length,
        Vary:'Accept-Encoding', ...(encoded ? {'Content-Encoding':'gzip'} : {})});
    recordResponseQueued(response); response.end(body);
}
function acceptsGzip(header: string): boolean {
    const entries = header.split(',').map(entry => {
        const [name, ...parameters] = entry.trim().toLowerCase().split(';');
        const quality = parameters.map(value => value.trim()).find(value => value.startsWith('q='));
        return {name, weight:quality ? Number(quality.slice(2)) : 1};
    });
    const selected = entries.find(entry => entry.name === 'gzip') ?? entries.find(entry => entry.name === '*');
    return !!selected && selected.weight > 0 && selected.weight <= 1;
}
export function sendError(response: ServerResponse, error: unknown): void {
    if (response.headersSent) { response.destroy(); return; }
    const raw = error instanceof Error ? error.message : String(error);
    const code = error instanceof FSError ? error.code : errorCode(error, raw);
    response.setHeader('X-VFS-Error', code);
    const status = code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : code === 'ECONFLICT' ? 409 : code === 'EFBIG' ? 413 : code === 'EIO' ? 500 : 400;
    const requestId = response.getHeader('X-Request-ID'), traceId = response.getHeader('X-Trace-ID');
    json(response, status, {error: {code, message: error instanceof FSError ? raw : code,
        ...(typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId) ? {requestId} : {}),
        ...(typeof traceId === 'string' && /^[a-f0-9]{32}$/.test(traceId) ? {traceId} : {})}});
}
function errorCode(error: unknown, message: string): FSErrorCode {
    const code = (error as NodeJS.ErrnoException)?.code ?? message.match(/\b(E[A-Z]+)\b/)?.[1];
    const known = ['ENOENT', 'EEXIST', 'EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EACCES', 'EROFS', 'ENOSPC', 'EINVAL', 'ELOOP', 'EFBIG', 'EBUSY'];
    return known.includes(code ?? '') ? code as FSErrorCode : 'EIO';
}

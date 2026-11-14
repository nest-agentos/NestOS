import { readFile, realpath, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { gzip, brotliCompress, constants } from 'node:zlib';
import { promisify } from 'node:util';
import { FSError } from '@nestos/vfs-core';

const compress = promisify(gzip), brotli = promisify(brotliCompress);
type Encoding = 'br' | 'gzip' | undefined;
type Asset = { body: Buffer; etag: string };
const assets = new Map<string, { ready: Promise<Asset>; size: number }>();
let cachedBytes = 0;
function asset(file: string, revision: string, encoded: Encoding): Promise<Asset> {
    const key = JSON.stringify([file, revision, encoded]), cached = assets.get(key);
    if (cached) { assets.delete(key); assets.set(key, cached); return cached.ready; }
    const entry: { size: number; ready: Promise<Asset> } = { size: 0, ready: readFile(file).then(async body => {
        if (encoded === 'br') body = await brotli(body, {params: {[constants.BROTLI_PARAM_QUALITY]: 5}});
        else if (encoded === 'gzip') body = await compress(body);
        if (assets.get(key) === entry) { entry.size = body.length; cachedBytes += entry.size; trimAssets(); }
        return { body, etag: '"' + createHash('sha256').update(body).digest('base64url') + '"' };
    }).catch(error => { if (assets.get(key) === entry) assets.delete(key); throw error; }) };
    assets.set(key, entry); trimAssets(); return entry.ready;
}
function trimAssets(): void {
    while (assets.size > 64 || cachedBytes > 16 * 1024 * 1024) {
        const key = assets.keys().next().value!; cachedBytes -= assets.get(key)!.size; assets.delete(key);
    }
}
export async function serveStatic(response: ServerResponse, method: string, directory: string, pathname: string, acceptEncoding: boolean | string, ifNoneMatch?: string): Promise<void> {
    const root = await realpath(directory);
    const target = path.resolve(root, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`);
    if (!inside(root, target) || !inside(root, await realpath(target))) throw new FSError('EACCES', 'Static path is outside the UI root');
    const info = await stat(target);
    if (!info.isFile()) throw new FSError('ENOENT', 'Static file not found');
    const encoded = /\.(html|js|css|json|svg)$/.test(target) ? encoding(acceptEncoding) : undefined;
    const { body, etag } = await asset(target, `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`, encoded);
    const immutable = /\/assets\/[^/]+-[\w-]{8,}\.[\w.]+$/.test(target);
    const unchanged = ifNoneMatch?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*');
    response.writeHead(unchanged ? 304 : 200, { 'Content-Type': mime(target), ...(!unchanged ? { 'Content-Length': body.length } : {}),
        'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        Vary: 'Accept-Encoding', ...(encoded ? { 'Content-Encoding': encoded } : {}) });
    response.end(method === 'HEAD' || unchanged ? undefined : body);
}
function inside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function mime(file: string): string {
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
        '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
    return types[path.extname(file)] ?? 'application/octet-stream';
}

/** Respect explicit exclusions; prefer Brotli when both supported encodings have equal quality. */
function encoding(header: boolean | string): Encoding {
    if (typeof header === 'boolean') return header ? 'gzip' : undefined;
    const qualities = new Map(header.toLowerCase().split(',').map(part => {
        const [name, ...parameters] = part.trim().split(';');
        const parameter = parameters.find(value => value.trim().startsWith('q='));
        const value = parameter === undefined ? 1 : Number(parameter.trim().slice(2));
        return [name.trim(), Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0] as const;
    }));
    const quality = (name: string) => qualities.get(name) ?? qualities.get('*') ?? 0;
    const br = quality('br'), gzip = quality('gzip');
    if ((qualities.get('identity') ?? 0) > Math.max(br, gzip)) return;
    return br > 0 && br >= gzip ? 'br' : gzip > 0 ? 'gzip' : undefined;
}

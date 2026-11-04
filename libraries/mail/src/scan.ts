import type {FSFileNode, IFileSystem} from '@nestos/vfs-core';
import type {MailSource} from './contracts';
import {normalizeSearch, parseMail, parseMailSource, safeCode, threadId} from './model';
import type {IndexedMail, MailIndex} from './storage';
export const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
export const stamp = (node: FSFileNode) => JSON.stringify([node.version, node.modifiedAt, node.size]);
export async function text(files: IFileSystem, node: FSFileNode, limit = 512 * 1024): Promise<string> {
    if ((node.size ?? 0) > limit) throw new Error('MAIL_FILE_TOO_LARGE');
    const content = await files.driver.readContent(node.path, {encoding: 'utf-8', length: limit + 1});
    if (new TextEncoder().encode(content).byteLength > limit) throw new Error('MAIL_FILE_TOO_LARGE');
    return content;
}
/** Continuous bounded workers avoid a barrier after each eight files. */
export async function pool<T, R>(items: T[], read: (item: T) => Promise<R>): Promise<R[]> {
    let position = 0; const results: R[] = new Array(items.length);
    const outcomes = await Promise.allSettled(Array.from({length: Math.min(8, items.length)}, async () => {
        while (position < items.length) {const index = position++; results[index] = await read(items[index]);}
    }));
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return results;
}
async function entries(files: IFileSystem): Promise<FSFileNode[]> {
    const queue = ['/'], rows: FSFileNode[] = []; let visited = 0;
    while (queue.length) {
        const groups = await pool(queue.splice(0, 8), path => files.driver.getChildren(path, {includeHidden: true}));
        for (const nodes of groups) for (const node of nodes) {
            if (++visited > 20000) throw new Error('MAIL_FILE_COUNT_LIMIT');
            if (node.name.startsWith('.') && node.name !== '.mail-source.json') continue;
            if (node.type === 'directory') queue.push(node.path);
            else if (node.type === 'file' && (node.name === '.mail-source.json' || node.name.endsWith('.email'))) rows.push(node);
        }
    }
    return rows;
}
function nearest(sources: Map<string, MailSource>, path: string): MailSource {
    let directory = parent(path);
    while (true) {const source = sources.get(directory); if (source) return source; if (directory === '/') break; directory = parent(directory);}
    const id = parent(path), segments = id.split('/').filter(Boolean);
    return {id, providerId: segments[0] || 'local', provider: segments[0] || 'Local', accountId: id, account: segments.slice(1).join(' / ') || 'Local', name: ''};
}
export async function scan(files: IFileSystem, previous: MailIndex) {
    const all = await entries(files), sources = new Map<string, MailSource>(), warnings: string[] = []; let readCount = 0, bytes = 0;
    await pool(all.filter(node => node.name === '.mail-source.json'), async node => {
        try {readCount++; const source = parseMailSource(await text(files, node, 8192), parent(node.path)); sources.set(source.id, source);}
        catch (error) {warnings.push(safeCode(error));}
    });
    const messages = all.filter(node => node.name.endsWith('.email')), cache = new Map(previous.rows.map(row => [row.summary.id, row]));
    if (messages.reduce((total, node) => total + (node.size ?? 0), 0) > 32 * 1024 * 1024) throw new Error('MAIL_TOTAL_SIZE_LIMIT');
    const rows = await pool(messages, async node => {
        try {
            const source = nearest(sources, node.path); sources.set(source.id, source);
            const cached = cache.get(node.path);
            if (cached?.stamp === stamp(node)) return {...cached, summary: {...cached.summary, sourceId: source.id}, thread: threadId(source.id, cached.summary.subject)};
            readCount++; const content = await text(files, node), document = parseMail(content, node.name);
            if ([document.subject, document.from, document.to].some(value => value.length > 4096)) throw new Error('MAIL_HEADER_TOO_LARGE');
            const size = new TextEncoder().encode(content).byteLength; bytes += size;
            if (bytes > 32 * 1024 * 1024) throw new Error('MAIL_TOTAL_SIZE_LIMIT');
            return {stamp: stamp(node), thread: threadId(source.id, document.subject), text: normalizeSearch(document.body),
                summary: {id: node.path, sourceId: source.id, subject: document.subject, from: document.from, to: document.to,
                    date: document.date, modified: Number(node.modifiedAt) || 0, size, version: String(node.version)}} satisfies IndexedMail;
        } catch (error) {if (safeCode(error) === 'MAIL_TOTAL_SIZE_LIMIT') throw error; warnings.push(safeCode(error)); return undefined;}
    });
    return {index: {revision: previous.revision + 1, rows: rows.filter((row): row is IndexedMail => !!row).sort((a, b) => a.summary.id.localeCompare(b.summary.id)), sources: [...sources.values()].sort((a, b) => a.id.localeCompare(b.id)), warnings: [...new Set(warnings)].sort()}, readCount, bytes};
}

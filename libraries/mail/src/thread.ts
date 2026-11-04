import type {IFileSystem} from '@itookit/vfs-core';
import {MAIL_PAGE_SIZE, type MailThreadPage, type MailThreadQuery} from './contracts';
import {parseMail} from './model';
import {newest, validateThreadQuery} from './query';
import {pool, stamp, text} from './scan';
import type {MailIndex} from './storage';
export async function readThread(index: MailIndex, files: IFileSystem, query: MailThreadQuery, invalidate: () => void): Promise<MailThreadPage> {
    validateThreadQuery(query);
    const resolved = index.rows.find(row => row.summary.id === query.id)?.thread ?? query.id;
    const rows = index.rows.filter(row => row.thread === resolved && (!query.sourceId || row.summary.sourceId === query.sourceId)).sort(newest);
    if (!rows.length) throw new Error('MAIL_MESSAGE_UNAVAILABLE');
    if (query.revision && query.revision !== String(index.revision)) throw new Error('MAIL_THREAD_CHANGED');
    const offset = query.offset ?? 0; if (offset >= rows.length) throw new Error('MAIL_QUERY_INVALID');
    const sources = new Map(index.sources.map(source => [source.id, source])), selected = []; let bytes = 0;
    for (const row of rows.slice(offset, offset + MAIL_PAGE_SIZE)) {
        if (selected.length && bytes + row.summary.size > 1024 * 1024) break;
        selected.push(row); bytes += row.summary.size;
    }
    const messages = await pool(selected, async row => {
        const node = await files.driver.getNode(row.summary.id);
        if (!node || node.type !== 'file' || stamp(node) !== row.stamp) {invalidate(); throw new Error('MAIL_THREAD_CHANGED');}
        const document = parseMail(await text(files, node), node.name), after = await files.driver.getNode(row.summary.id);
        if (!after || after.type !== 'file' || stamp(after) !== row.stamp) {invalidate(); throw new Error('MAIL_THREAD_CHANGED');}
        return {...row.summary, body: document.body, source: sources.get(row.summary.sourceId)!};
    });
    const next = offset + messages.length;
    return {id: resolved, subject: rows[0].summary.subject, revision: String(index.revision), total: rows.length, offset,
        nextOffset: next < rows.length ? next : undefined, messages};
}

import {MAIL_PAGE_SIZE, type MailPage, type MailQuery, type MailThread, type MailThreadQuery} from './contracts';
import {normalizeSearch} from './model';
import type {IndexedMail, MailIndex} from './storage';
export const newest = (a: IndexedMail, b: IndexedMail) => (b.summary.date || b.summary.modified) - (a.summary.date || a.summary.modified) || a.summary.id.localeCompare(b.summary.id);
function validText(value: unknown, limit: number): boolean {return value === undefined || typeof value === 'string' && value.length <= limit;}
function validInteger(value: unknown, minimum: number): boolean {return value === undefined || Number.isSafeInteger(value) && Number(value) >= minimum;}
export function validateQuery(query: MailQuery): void {
    if (!query || typeof query !== 'object') throw new Error('MAIL_QUERY_INVALID');
    const fields = [validText(query.search, 1000), validText(query.sourceId, 65536), validInteger(query.page, 1),
        query.searchMode === undefined || ['headers', 'content'].includes(query.searchMode)];
    if (!fields.every(Boolean)) throw new Error('MAIL_QUERY_INVALID');
}
export function validateThreadQuery(query: MailThreadQuery): void {
    if (!query || typeof query !== 'object' || typeof query.id !== 'string') throw new Error('MAIL_QUERY_INVALID');
    if (![validText(query.id, 65536), validText(query.sourceId, 65536), validText(query.revision, 100), validInteger(query.offset, 0)].every(Boolean))
        throw new Error('MAIL_QUERY_INVALID');
}
export function queryIndex(index: MailIndex, query: MailQuery): MailPage {
    validateQuery(query);
    const sources = new Map(index.sources.map(source => [source.id, source])), tokens = normalizeSearch(query.search ?? '').split(' ').filter(Boolean);
    const groups = new Map<string, {rows: IndexedMail[]; matches: boolean}>(), counts = new Map<string, number>(); let messageCount = 0;
    for (const row of index.rows) {
        const item = row.summary; counts.set(item.sourceId, (counts.get(item.sourceId) ?? 0) + 1); if (query.sourceId && item.sourceId !== query.sourceId) continue;
        const source = sources.get(item.sourceId);
        const headers = normalizeSearch([item.subject, item.from, item.to, source?.account, source?.provider, source?.name].join(' '));
        const matches = tokens.every(token => (query.searchMode === 'content' ? headers + ' ' + row.text : headers).includes(token));
        if (matches) messageCount++;
        const group = groups.get(row.thread) ?? {rows: [], matches: false};
        group.rows.push(row); group.matches ||= matches; groups.set(row.thread, group);
    }
    const threads: MailThread[] = [...groups].filter(([, group]) => group.matches).map(([id, group]) => {
        group.rows.sort(newest); return {...group.rows[0].summary, id, count: group.rows.length};
    }).sort((a, b) => (b.date || b.modified) - (a.date || a.modified) || a.id.localeCompare(b.id));
    const page = Math.min(query.page ?? 1, Math.max(1, Math.ceil(threads.length / MAIL_PAGE_SIZE)));
    return {threads: threads.slice((page - 1) * MAIL_PAGE_SIZE, page * MAIL_PAGE_SIZE), total: threads.length, page, pageSize: MAIL_PAGE_SIZE,
        messageCount, warnings: [...index.warnings], sources: index.sources.map(source => ({...source, count: counts.get(source.id) ?? 0}))};
}

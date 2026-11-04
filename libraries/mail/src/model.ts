import type {MailDocument, MailSource} from './contracts';
export function parseMail(content: string, fallback: string): MailDocument {
    const boundary = content.search(/\r?\n\r?\n/), header = boundary < 0 ? '' : content.slice(0, boundary);
    const headers = new Map<string, string>();
    for (const line of header.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
        const colon = line.indexOf(':'); if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
    }
    const date = Date.parse(headers.get('date') ?? '');
    return {subject: headers.get('subject') || fallback, from: headers.get('from') ?? '', to: headers.get('to') ?? '',
        date: Number.isFinite(date) ? date : 0, body: headers.size ? content.slice(boundary).replace(/^\r?\n\r?\n/, '') : content};
}
export function parseMailSource(content: string, directory: string): MailSource {
    const value = JSON.parse(content);
    if (value?.format !== 'nestos.mail-source' || value.version !== 1 || !value.provider || !value.account
        || ![value.provider.id, value.provider.name, value.account.id, value.account.name].every(item => typeof item === 'string' && item.length > 0 && item.length <= 300))
        throw new Error('MAIL_SOURCE_INVALID');
    return {id: directory, name: typeof value.name === 'string' ? value.name.slice(0, 300) : '',
        providerId: value.provider.id, provider: value.provider.name, accountId: value.account.id, account: value.account.name};
}
export const normalizeSearch = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function normalizedSubject(subject: string): string {
    return normalizeSearch(subject).replace(/^(?:(?:re|fw|fwd|回复|答复|转发)\s*(?:\[\d+\])?\s*[:：]\s*)+/i, '').trim();
}
export function threadId(sourceId: string, subject: string): string {
    return '/threads/' + encodeURIComponent(JSON.stringify([sourceId, normalizedSubject(subject)]));
}
export function safeCode(error: unknown): string {
    const code = (error as {code?: string})?.code ?? (error instanceof Error ? error.message : '');
    return /^(MAIL_[A-Z_]+|ENOENT|EACCES|EIO|ENETUNREACH|ECONFLICT|ECAPABILITY)$/.test(code) ? code
        : error instanceof SyntaxError ? 'MAIL_SOURCE_INVALID' : 'MAIL_READ_FAILED';
}

export function mailError(code: string): Error & {code: string} {return Object.assign(new Error(code), {code});}

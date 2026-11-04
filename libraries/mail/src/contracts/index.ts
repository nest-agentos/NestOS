export const MAIL_PAGE_SIZE = 20;
export interface MailSource {id: string; name: string; providerId: string; provider: string; accountId: string; account: string}
export interface MailSummary {
    id: string; sourceId: string; subject: string; from: string; to: string; date: number; modified: number; size: number; version: string;
}
export interface MailThread extends MailSummary {count: number}
export interface MailQuery {sourceId?: string; search?: string; searchMode?: 'headers' | 'content'; page?: number}
export interface MailPage {
    threads: MailThread[]; sources: Array<MailSource & {count: number}>;
    total: number; messageCount: number; page: number; pageSize: number; warnings: string[];
}
export interface MailDocument {subject: string; from: string; to: string; date: number; body: string}
export interface MailThreadQuery {id: string; offset?: number; revision?: string; sourceId?: string}
export interface MailThreadPage {
    id: string; subject: string; revision: string; total: number; offset: number; nextOffset?: number;
    messages: Array<MailSummary & {body: string; source: MailSource}>;
}
/** Calls operate on one host-authorized archive; callers never choose a filesystem root. */
export interface MailClient {
    queryMail(query?: MailQuery): Promise<MailPage>;
    readThread(query: MailThreadQuery): Promise<MailThreadPage>;
    refreshMail(): Promise<void>;
    dispose(): Promise<void>;
}
export interface MailDiagnostic {
    operation: string; operationId: string; stage: string; result: 'success' | 'partial' | 'failure'; durationMs: number;
    code?: string; count?: number; readCount?: number; bytes?: number; warningCount?: number;
}

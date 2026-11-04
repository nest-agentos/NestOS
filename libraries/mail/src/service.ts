import {readThread} from './thread';
import type {IFileSystem} from '@itookit/vfs-core';
import type {MailClient, MailDiagnostic, MailQuery, MailThreadPage, MailThreadQuery} from './contracts';
import {safeCode, mailError} from './model';
import {queryIndex, validateQuery, validateThreadQuery} from './query';
import {scan} from './scan';
import {SeqMailIndex, type MailIndex} from './storage';
export interface MailArchiveOptions {
    files: IFileSystem; storage: IFileSystem; indexPath: string;
    createOperationId(): string; diagnostic?(record: MailDiagnostic): void;
}
/** Shared by the host across browser views, isolated by the authorized archive. */
export class MailArchive implements MailClient {
    private index?: MailIndex;
    private pending?: Promise<MailIndex>;
    private generation = 0;
    private checked = 0;
    private dirty = true;
    private closed = false;
    private closing?: Promise<void>;
    private readonly operations = new Set<Promise<unknown>>();
    private readonly store: SeqMailIndex;
    private readonly stop: () => void;
    constructor(private readonly options: MailArchiveOptions) {
        this.store = new SeqMailIndex(options.storage, options.indexPath);
        this.stop = options.files.onAny?.(event => {if (event.type.startsWith('node:')) this.invalidate();}) ?? (() => {});
    }
    async queryMail(query: MailQuery = {}) {
        return this.trace('mail.query', 'index.query', async () => {validateQuery(query); return queryIndex(await this.ready(), query);});
    }
    async readThread(query: MailThreadQuery): Promise<MailThreadPage> {
        return this.trace('mail.thread', 'body.read', async () => {
            validateThreadQuery(query);
            return readThread(await this.ready(), this.options.files, query, () => this.invalidate());
        });
    }
    async refreshMail(): Promise<void> {await this.trace('mail.refresh', 'index.refresh', async () => {this.invalidate(); await this.ready();});}
    private invalidate(): void {this.generation++; this.dirty = true;}
    private ready(): Promise<MailIndex> {
        if (this.closed) return Promise.reject(new Error('MAIL_CLOSED'));
        if (!this.dirty && this.index && Date.now() - this.checked < 30000) return Promise.resolve(this.index);
        return this.pending ??= this.reconcile().finally(() => {this.pending = undefined;});
    }
    private async reconcile(): Promise<MailIndex> {
        this.index ??= await this.trace('mail.index', 'index.load', () => this.store.read());
        for (let attempt = 0; attempt < 3; attempt++) {
            const generation = this.generation, operationId = this.options.createOperationId(), started = Date.now(); let stage = 'index.scan';
            try {
                const {index, readCount, bytes} = await scan(this.options.files, this.index);
                if (generation !== this.generation) {
                    this.report({operation: 'mail.index', operationId, stage: 'index.scan', result: 'partial', code: 'MAIL_INDEX_STALE', readCount, bytes, durationMs: Date.now() - started});
                    continue;
                }
                const changed = JSON.stringify([index.rows, index.sources, index.warnings]) !== JSON.stringify([this.index.rows, this.index.sources, this.index.warnings]);
                if (changed) {stage = 'index.persist'; await this.store.write(this.index, index); this.index = index;}
                this.dirty = generation !== this.generation; this.checked = Date.now();
                this.report({operation: 'mail.index', operationId, stage: 'reconcile', result: index.warnings.length ? 'partial' : 'success',
                    readCount, bytes, count: index.rows.length, warningCount: index.warnings.length, durationMs: Date.now() - started});
                if (!this.dirty) return this.index;
            } catch (error) {
                this.report({operation: 'mail.index', operationId, stage, result: 'failure', code: safeCode(error), durationMs: Date.now() - started});
                if (safeCode(error) !== 'MAIL_INDEX_CONFLICT') throw error;
                this.index = await this.store.read();
            }
        }
        throw new Error('MAIL_ARCHIVE_CHANGING');
    }
    private trace<T>(operation: string, stage: string, read: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('MAIL_CLOSED'));
        const pending = this.observe(operation, stage, read); this.operations.add(pending);
        void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending)); return pending;
    }
    private async observe<T>(operation: string, stage: string, read: () => Promise<T>): Promise<T> {
        const operationId = this.options.createOperationId(), started = Date.now();
        try {const result = await read(); this.report({operation, operationId, stage, result: 'success', durationMs: Date.now() - started}); return result;}
        catch (error) {const code = safeCode(error); this.report({operation, operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw mailError(code);}
    }
    private report(record: MailDiagnostic): void {try {this.options.diagnostic?.(record);} catch { /* Diagnostics do not alter archive reads. */ }}
    dispose(): Promise<void> {
        if (this.closing) return this.closing;
        this.closed = true; this.stop(); return this.closing = Promise.allSettled([...this.operations]).then(() => {});
    }
}

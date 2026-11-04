import {FSError, type IFileSystem} from '@nestos/vfs-core';
import type {MailSource, MailSummary} from './contracts';
export interface IndexedMail {stamp: string; summary: MailSummary; text: string; thread: string}
export interface MailIndex {revision: number; rows: IndexedMail[]; sources: MailSource[]; warnings: string[]}
interface Manifest {format: 1; revision: number; ids: string[]; sources: MailSource[]; warnings: string[]}
export class SeqMailIndex {
    constructor(private readonly fs: IFileSystem, private readonly path: string) {}
    async read(): Promise<MailIndex> {
        if (!await this.fs.driver.exists(this.path)) return {revision: 0, rows: [], sources: [], warnings: []};
        const seq = this.fs.meta.seq;
        if (!seq?.transaction) throw new Error('MAIL_INDEX_UNSUPPORTED');
        return seq.transaction(async tx => {
            const raw = await tx.getEntry(this.path, 'index');
            if (!raw) return {revision: 0, rows: [], sources: [], warnings: []};
            const manifest = JSON.parse(raw) as Manifest;
            if (manifest.format !== 1 || !Array.isArray(manifest.ids)) throw new Error('MAIL_INDEX_INVALID');
            const entries = await tx.getEntries(this.path, manifest.ids.map(key));
            const rows = manifest.ids.map(id => {
                const value = entries[key(id)]; if (!value) throw new Error('MAIL_INDEX_INVALID');
                const row = JSON.parse(value) as IndexedMail;
                if (row.summary?.id !== id || typeof row.text !== 'string' || typeof row.stamp !== 'string') throw new Error('MAIL_INDEX_INVALID');
                return row;
            });
            return {revision: manifest.revision, rows, sources: manifest.sources, warnings: manifest.warnings};
        });
    }
    async write(previous: MailIndex, next: MailIndex): Promise<void> {
        const seq = this.fs.meta.seq; if (!seq?.transaction) throw new Error('MAIL_INDEX_UNSUPPORTED');
        const at = this.path.lastIndexOf('/');
        try {await this.fs.driver.createFile({parentPath: this.path.slice(0, at) || '/', name: this.path.slice(at + 1), type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        await seq.transaction(async tx => {
            const manifest = JSON.parse(await tx.getEntry(this.path, 'index') ?? '{"revision":0}') as Manifest;
            if (manifest.revision !== previous.revision) throw new Error('MAIL_INDEX_CONFLICT');
            const before = new Map(previous.rows.map(row => [row.summary.id, JSON.stringify(row)])), ids = new Set(next.rows.map(row => row.summary.id));
            for (const row of next.rows) if (before.get(row.summary.id) !== JSON.stringify(row)) await tx.setEntry(this.path, key(row.summary.id), JSON.stringify(row));
            for (const id of before.keys()) if (!ids.has(id)) await tx.deleteEntry(this.path, key(id));
            await tx.setEntry(this.path, 'index', JSON.stringify({format: 1, revision: next.revision, ids: [...ids], sources: next.sources, warnings: next.warnings} satisfies Manifest));
        });
    }
}
const key = (id: string) => 'message/' + encodeURIComponent(id);

/** User-selected directories are independent sources, never global root mounts. */
import { openLocalFSBackend } from '@itookit/vfsdriver-local';
import { createFileSystemSource, type FileSystemContext, type FileSystemSourceOwner, type IFileSystem } from '@itookit/vfs-core';
import { TauriSqlSidecarDb } from '../db/tauri-sql-sidecar';
import { TauriFsOps } from '../fs/tauri-fs-ops';
import { randomUUID } from '@itookit/common';

export interface MountEntry {
    id: string;
    localPath: string;
    sidecarPath: string;
    label: string;
    mountedAt: number;
}
export const MOUNT_EVENTS = { ADDED: 'localfs:mount:added', REMOVED: 'localfs:mount:removed' } as const;

export class LocalMountService {
    private readonly registry = new Map<string, MountEntry>();
    private readonly sources = new Map<string, FileSystemSourceOwner>();
    private tail: Promise<unknown> = Promise.resolve();
    private closed = false;

    constructor(private readonly files: IFileSystem, private readonly rootDir: string, private readonly beforeUnmount?: (id: string) => Promise<void>) {}

    mount(localPath: string, label: string): Promise<MountEntry> {
        return this.serial(async () => {
            const id = `mnt_${randomUUID()}`;
            const entry = { id, localPath, label, mountedAt: Date.now(), sidecarPath: `${this.rootDir}/meta/sources/${id}` };
            const source = await this.open(entry);
            this.registry.set(id, entry);
            try { await this.persist(); }
            catch (error) { this.registry.delete(id); await source.dispose(); throw error; }
            this.sources.set(id, source);
            document.dispatchEvent(new CustomEvent(MOUNT_EVENTS.ADDED, { detail: entry }));
            return entry;
        });
    }

    unmount(id: string): Promise<void> {
        return this.serial(async () => {
            const entry = this.registry.get(id);
            if (!entry) return;
            await this.beforeUnmount?.(id);
            this.registry.delete(id);
            try { await this.persist(); }
            catch (error) { this.registry.set(id, entry); throw error; }
            await this.sources.get(id)?.dispose();
            this.sources.delete(id);
            document.dispatchEvent(new CustomEvent(MOUNT_EVENTS.REMOVED, { detail: entry }));
        });
    }

    contextFor(id: string): FileSystemContext {
        const source = this.sources.get(id);
        if (this.closed || !source) throw new Error(`Local source unavailable: ${id}`);
        return { fs: source.fs, cwd: '/' };
    }

    listMounts(): MountEntry[] { return [...this.registry.values()].map(entry => ({ ...entry })); }

    restoreMounts(): Promise<void> {
        return this.serial(async () => {
            if (!await this.files.driver.exists('/sources.json')) return;
            const saved = JSON.parse(await this.files.driver.readContent('/sources.json', { encoding: 'utf-8' }));
            if (saved.version !== 1 || !Array.isArray(saved.entries)) throw new Error('Unsupported local source registry');
            for (const entry of saved.entries as MountEntry[]) {
                if (!/^mnt_[a-zA-Z0-9_-]+$/.test(entry.id) || typeof entry.localPath !== 'string' || typeof entry.sidecarPath !== 'string') throw new Error('Invalid local source descriptor');
                if (this.sources.has(entry.id)) continue;
                // Keep unavailable sources in the persistent registry for explicit repair.
                this.registry.set(entry.id, entry);
                try {
                    this.sources.set(entry.id, await this.open(entry));
                    document.dispatchEvent(new CustomEvent(MOUNT_EVENTS.ADDED, { detail: entry }));
                } catch (error) { console.warn(`[LocalMountService] Source unavailable: ${entry.id}`, error); }
            }
        });
    }

    async dispose(): Promise<void> {
        this.closed = true;
        await this.tail.catch(() => {});
        const results = await Promise.allSettled([...this.sources.values()].map(source => source.dispose()));
        this.sources.clear();
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
    }

    private async open(entry: MountEntry): Promise<FileSystemSourceOwner> {
        const backend = await openLocalFSBackend({ rootDir: entry.localPath, sidecarDir: entry.sidecarPath,
            createDb: dbPath => TauriSqlSidecarDb.open(dbPath), createFs: () => new TauriFsOps() });
        try { return await createFileSystemSource({ tags: false, backend, viewId: entry.id }); }
        catch (error) { await backend.close(); throw error; }
    }

    private async persist(): Promise<void> {
        const content = JSON.stringify({ version: 1, entries: this.listMounts() }, null, 2);
        if (await this.files.driver.exists('/sources.json')) await this.files.driver.writeContent('/sources.json', content);
        else await this.files.driver.createFile({ name: 'sources.json', parentPath: '/', content });
    }

    private serial<T>(operation: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error('Local source service is closed'));
        const next = this.tail.catch(() => {}).then(() => {
            if (this.closed) throw new Error('Local source service is closed');
            return operation();
        });
        this.tail = next;
        return next;
    }
}

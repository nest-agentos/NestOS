import { invoke } from '@tauri-apps/api/core';
import { createFileSystemSource, type FileSystemSourceOwner, type IFileSystem } from '@itookit/vfs-core';
import { sha256Hex } from '@itookit/common';
import { openLocalFSBackend, type IFsOps, type StatResult, type DirEntry } from '@itookit/vfsdriver-local';
import { TauriFsOps } from '../fs/tauri-fs-ops';
import { TauriSqlSidecarDb } from '../db/tauri-sql-sidecar';

interface Scope { id: string; root: string; }
export class ScopedFsOps implements IFsOps {
    constructor(private readonly scopes: Scope[]) {}
    private target(path: string) {
        const normalized = path.replace(/\\/g, '/');
        const scope = this.scopes.find(s => normalized === s.root || (s.root === '/' ? normalized.startsWith('/') : normalized.startsWith(s.root + '/')));
        if (!scope) throw new Error('Path outside directory source');
        return { id: scope.id, path: normalized.slice(scope.root.length).replace(/^\//, '') };
    }
    private io<T>(operation: string, path: string, extra: object = {}): Promise<T> { return invoke('directory_io', { ...this.target(path), operation, ...extra }); }
    stat(path: string) { return this.io<StatResult | null>('stat', path); }
    async statMany(paths: string[]): Promise<Array<StatResult | null>> {
        const groups = new Map<string, Array<{ path: string; index: number }>>();
        paths.forEach((path, index) => {
            const target = this.target(path);
            const group = groups.get(target.id) ?? [];
            group.push({ path: target.path, index }); groups.set(target.id, group);
        });
        const output: Array<StatResult | null> = new Array(paths.length);
        await Promise.all([...groups].map(async ([id, entries]) => {
            for (let start = 0; start < entries.length; start += 256) {
                const batch = entries.slice(start, start + 256);
                const rows = await invoke<Array<StatResult | null>>('directory_stat_many', { id, paths: batch.map(item => item.path) });
                if (rows.length !== batch.length) throw new Error('Invalid directory stat response');
                batch.forEach((item, index) => { output[item.index] = rows[index]; });
            }
        }));
        return output;
    }
    exists(path: string) { return this.io<boolean>('exists', path); }
    mkdir(path: string) { return this.io<void>('mkdir', path); }
    readDir(path: string) { return this.io<DirEntry[]>('list', path); }
    readFile(path: string): Promise<ArrayBuffer | null> { return invoke('directory_read_file', this.target(path)); }
    async readFileRange(path: string, offset: number, length: number): Promise<ArrayBuffer | null> {
        const bytes = await invoke<number[] | null>('directory_read_range', { ...this.target(path), offset, length });
        return bytes ? new Uint8Array(bytes).buffer : null;
    }
    writeFile(path: string, data: ArrayBuffer) { return this.io<void>('write', path, { data: Array.from(new Uint8Array(data)) }); }
    appendFile(path: string, data: ArrayBuffer) { return this.io<void>('append', path, { data: Array.from(new Uint8Array(data)) }); }
    rename(from: string, to: string) { const a = this.target(from), b = this.target(to); if (a.id !== b.id) throw new Error('Cross-source rename forbidden'); return this.io<void>('rename', from, { to: b.path }); }
    unlink(path: string) { return this.io<void>('unlink', path); }
    rmdir(path: string) { return this.io<void>('rmdir', path); }
}

/** Sources for Session grants. Choosing one does not create a global workspace. */
export class TauriSessionDirectories {
    private closing?: Promise<void>;
    private closed = false;
    private readonly disposedOwners = new WeakSet<FileSystemSourceOwner>();
    private readonly closedScopes = new Set<string>();
    private readonly sources = new Map<string, Promise<{ owner: FileSystemSourceOwner; scopes: Scope[] }>>();
    private readonly canonical = new Map<string, Promise<{ owner: FileSystemSourceOwner; scopes: Scope[] }>>();
    constructor(private readonly rootDir: string) {}
    async selectDirectory(): Promise<string | null> {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const result = await open({ directory: true, multiple: false });
        return typeof result === 'string' ? 'host:' + result : null;
    }
    async openDirectory(path: string): Promise<IFileSystem> {
        if (this.closed) throw new Error('Directory source provider closed');
        if (!this.sources.has(path)) this.sources.set(path, this.open(path));
        try { return (await this.sources.get(path)!).owner.fs; }
        catch (error) { this.sources.delete(path); throw error; }
    }
    private async open(path: string) {
        const data = await invoke<Scope>('directory_open', { path });
        data.root = data.root.replace(/\\/g, '/').replace(/\/$/, '') || '/';
        const existing = this.canonical.get(data.root);
        if (existing) { await invoke('directory_close', { id: data.id }); return existing; }
        const pending = this.openScope(data);
        this.canonical.set(data.root, pending);
        try { return await pending; }
        catch (error) { this.canonical.delete(data.root); throw error; }
    }
    private async openScope(data: Scope) {
        const scopes: Scope[] = [data];
        try {
            const key = await sha256Hex(data.root);
            const sidecarPath = `${this.rootDir}/meta/session-sources/${key}`;
            await new TauriFsOps().mkdir(sidecarPath);
            const metadata = await invoke<Scope>('directory_open', { path: sidecarPath }); scopes.unshift(metadata);
            metadata.root = metadata.root.replace(/\\/g, '/').replace(/\/$/, '') || '/';
            const backend = await openLocalFSBackend({ rootDir: data.root, sidecarDir: metadata.root,
                createFs: () => new ScopedFsOps(scopes), createDb: p => TauriSqlSidecarDb.open(p) });
            try { return { owner: await createFileSystemSource({ tags: false, backend, viewId: `host-directory:${key}` }), scopes }; }
            catch (error) { await backend.close(); throw error; }
        } catch (error) { await Promise.allSettled(scopes.map(s => invoke('directory_close', { id: s.id }))); throw error; }
    }
    dispose(): Promise<void> {
        this.closed = true;
        if (this.closing) return this.closing;
        const pending = this.closeSources();
        this.closing = pending;
        void pending.catch(() => { if (this.closing === pending) this.closing = undefined; });
        return pending;
    }
    private async closeSources(): Promise<void> {
        const errors: unknown[] = [];
        // Include acquisitions that have not resolved their canonical path yet.
        const acquired = await Promise.allSettled(this.sources.values());
        const sources = new Set(acquired.flatMap(result => result.status === 'fulfilled' ? [result.value] : []));
        for (const source of sources) {
            try {
                if (!this.disposedOwners.has(source.owner)) await source.owner.dispose();
                this.disposedOwners.add(source.owner);
            } catch (error) { errors.push(error); continue; }
            const closed = await Promise.allSettled(source.scopes.map(async scope => {
                if (this.closedScopes.has(scope.id)) return;
                await invoke('directory_close', { id: scope.id });
                this.closedScopes.add(scope.id);
            }));
            for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
        }
        if (errors.length) throw new AggregateError(errors, 'Directory source cleanup failed');
        this.sources.clear(); this.canonical.clear(); this.closedScopes.clear();
    }
}

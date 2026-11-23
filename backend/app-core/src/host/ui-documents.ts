import { FSError, type IVFSManager } from '@nestos/vfs-core';
import { createModuleLogger } from '@nestos/common';
import type { PinnedWindow, PinnedWindowChange } from '@nestos/app-contracts/services';

const queues = new WeakMap<IVFSManager, Promise<void>>();
const pinFile = 'pinned-windows.json';
const log = createModuleLogger('pinned-windows');
type FileSystem = Awaited<ReturnType<IVFSManager['openFileSystem']>>;
function fileName(name: string): string {
    if (!name || name.length > 200) throw new FSError('EINVAL', 'Invalid UI document name');
    return `${name.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
}

export async function readUiDocuments(vfs: IVFSManager, names: string[]): Promise<Record<string, unknown>> {
    if (names.length > 32) throw new FSError('EINVAL', 'Too many UI documents');
    const files = names.map(name => [name, fileName(name)] as const);
    await queues.get(vfs);
    const fs = await vfs.openFileSystem('/etc');
    return Object.fromEntries(await Promise.all(files.map(async ([name, file]) => {
        try {
            const content = await fs.driver.readContent(`/ui/${file}`);
            return [name, JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content))];
        } catch { return [name, undefined]; }
    })));
}

/** Keep upsert and cross-client ordering beside storage, without interpreting UI schemas. */
export function writeUiDocuments(vfs: IVFSManager, documents: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(documents);
    if (entries.length > 32) return Promise.reject(new FSError('EINVAL', 'Too many UI documents'));
    const files = entries.map(([name, value]) => ({ file: fileName(name), content: JSON.stringify(value, null, 2) }));
    return queueWrite(vfs, async fs => {
        for (const {file, content} of files) await writeDocument(fs, file, content);
    });
}

function queueWrite(vfs: IVFSManager, write: (fs: FileSystem) => Promise<void>): Promise<void> {
    const pending = (queues.get(vfs) ?? Promise.resolve()).then(async () => {
        await write(await vfs.openFileSystem('/etc'));
    });
    queues.set(vfs, pending.catch(() => {}));
    return pending;
}

async function writeDocument(fs: FileSystem, file: string, content: string): Promise<void> {
    const path = `/ui/${file}`;
    if (await fs.driver.exists(path)) {
        if (await fs.driver.readContent(path, {encoding: 'utf-8'}) !== content) await fs.driver.writeContent(path, content);
    } else await fs.driver.createFile({name: file, parentPath: '/ui', content, recursive: true});
}

function validWindow(value: unknown): value is PinnedWindow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Partial<PinnedWindow>;
    return typeof row.workspace === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(row.workspace)
        && typeof row.resource === 'string' && !!row.resource && typeof row.title === 'string'
        && [row.scope, row.context, row.location].every(text => text === undefined || typeof text === 'string');
}

async function readPins(fs: FileSystem): Promise<PinnedWindow[]> {
    try {
        const content = await fs.driver.readContent(`/ui/${pinFile}`, {encoding: 'utf-8'});
        const pins: unknown = JSON.parse(typeof content === 'string' ? content : new TextDecoder().decode(content));
        if (!Array.isArray(pins) || !pins.every(validWindow)) throw new FSError('EINVAL', 'Invalid pinned windows');
        return pins;
    } catch (error) {
        if ((error as {code?: string})?.code === 'ENOENT') return [];
        throw error;
    }
}

export async function listPinnedWindows(vfs: IVFSManager): Promise<PinnedWindow[]> {
    await queues.get(vfs);
    return readPins(await vfs.openFileSystem('/etc'));
}

export async function setPinnedWindow(vfs: IVFSManager, change: PinnedWindowChange): Promise<void> {
    const started = performance.now();
    const operationId = typeof change?.operationId === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(change.operationId)
        ? change.operationId : undefined;
    try {
        if (!operationId || !validWindow(change.window) || typeof change.pinned !== 'boolean') {
            throw new FSError('EINVAL', 'Invalid pinned window change');
        }
        const {workspace, resource, title, scope, context, location} = change.window;
        await queueWrite(vfs, async fs => {
            const pins = (await readPins(fs)).filter(pin => pin.workspace !== workspace || pin.resource !== resource);
            if (change.pinned) pins.unshift({workspace, resource, title, scope, context, location});
            await writeDocument(fs, pinFile, JSON.stringify(pins));
        });
        log.debug('windows.pin', {operationId, stage: 'persist', result: 'success', durationMs: Math.round(performance.now() - started)});
    } catch (error) {
        log.warn('windows.pin', {operationId, stage: 'persist', result: 'failure', code: error instanceof FSError ? error.code : 'PIN_WRITE_FAILED',
            durationMs: Math.round(performance.now() - started)});
        throw error;
    }
}

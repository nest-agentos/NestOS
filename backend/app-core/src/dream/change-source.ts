import {createModuleLogger, sha256HexSync} from '@nestos/common';
import type {FSNode, IFileSystem} from '@nestos/vfs-core';
import type {ProjectService} from '@nestos/app-contracts/services';
import type {DreamSource, SourceAuthority, SourcePort} from '@nestos/dream';
import {documentPath, nodeVersion} from '../digital-twin/project-catalog';

export interface ChangeScope {directory: string; exclude: string[]; maxEntries: number; commits?: true; extensions?: string[]}
export interface ChangeSnapshot {text: string; hash: string; scanned: number; directories: number}
export interface DreamChangeSource extends ChangeScope {id: string; projectId: string; connectionId: string; scannerSourceId: string}
const log = createModuleLogger('dream-change-source');

export function changeSourcePort(source: DreamChangeSource, projects: ProjectService,
    authorize: (source: DreamChangeSource) => Promise<SourceAuthority>,
    readCommits?: (source: DreamChangeSource) => Promise<ChangeSnapshot>): SourcePort<string> {
    const frozen = structuredClone(source);
    const check = (input: DreamSource) => {
        if (input.id !== frozen.id || input.projectId !== frozen.projectId || input.connectionId !== frozen.connectionId)
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
    };
    return {authorize: async input => {check(input); return authorize(frozen);}, read: async (input, limit) => {
        const started = Date.now();
        try {
            check(input); if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('DREAM_SOURCE_LIMIT');
            const project = await projects.get(frozen.projectId);
            const snapshot = frozen.commits ? await readCommitSnapshot(frozen, readCommits) : await readProjectChanges(projects, project.path, frozen);
            const identity = JSON.stringify([project.project.id, project.project.directory, project.project.source,
                frozen.directory, frozen.exclude, frozen.maxEntries, ...(frozen.commits || frozen.extensions?.length ? [frozen.commits ?? false, frozen.extensions ?? []] : [])]);
            const version = JSON.stringify([identity, snapshot.hash]), cursor = sha256HexSync(version);
            log.info('dream.change.source', {operationId: frozen.id, stage: 'snapshot', result: 'success',
                scanned: snapshot.scanned, directories: snapshot.directories, durationMs: Date.now() - started});
            return {items: cursor === input.cursor || frozen.commits && !snapshot.scanned ? [] : [snapshot.text], cursor, version, scanned: 1};
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CHANGE_READ_FAILED';
            log.warn('dream.change.source', {operationId: frozen.id, stage: 'snapshot', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }};
}

async function readProjectChanges(projects: ProjectService, path: string, scope: ChangeScope): Promise<ChangeSnapshot> {
    const view = await projects.openFiles(path);
    try {return await readChangeSnapshot(view.fs, scope);}
    finally {await view.dispose();}
}

async function readCommitSnapshot(source: DreamChangeSource, read?: (source: DreamChangeSource) => Promise<ChangeSnapshot>) {
    if (!read) throw new Error('DREAM_GIT_UNAVAILABLE');
    return read(source);
}

/** Paths are absolute within the already authorized project view. */
export function validateChangeScope(scope: ChangeScope): void {
    const valid = (path: string) => typeof path === 'string' && path.startsWith('/') && path.length <= 1000
        && !/[\\\0]/.test(path) && (path === '/' || path.split('/').slice(1).every(part => !!part && !part.startsWith('.')));
    if (!scope || !valid(scope.directory) || !Array.isArray(scope.exclude) || scope.exclude.length > 32
        || !Number.isSafeInteger(scope.maxEntries) || scope.maxEntries < 1 || scope.maxEntries > 128
        || (scope.commits !== undefined && scope.commits !== true)
        || (scope.extensions !== undefined && (scope.commits || !Array.isArray(scope.extensions) || scope.extensions.length > 24
            || scope.extensions.some(value => typeof value !== 'string' || !/^[a-z0-9]{1,12}$/.test(value))))
        || scope.exclude.some(path => !valid(path) || path === scope.directory
            || !(scope.directory === '/' ? path.startsWith('/') : path.startsWith(scope.directory + '/'))))
        throw new Error('DREAM_CHANGE_SCOPE_INVALID');
}

/** Snapshot only the selected tree. Fail rather than advance a partial snapshot. */
export async function readChangeSnapshot(fs: IFileSystem, scope: ChangeScope): Promise<ChangeSnapshot> {
    validateChangeScope(scope);
    const first = await collect(fs, scope), second = await collect(fs, scope);
    if (first.text !== second.text) throw new Error('DREAM_CHANGE_SOURCE_CHANGED');
    return {...second, hash: sha256HexSync(second.text), scanned: first.scanned + second.scanned,
        directories: first.directories + second.directories};
}

async function collect(fs: IFileSystem, scope: ChangeScope): Promise<Omit<ChangeSnapshot, 'hash'>> {
    const parts = scope.directory.split('/').filter(Boolean);
    for (let i = 0; i <= parts.length; i++) {
        const node = await fs.driver.getNode('/' + parts.slice(0, i).join('/'));
        if (!node || node.type !== 'directory' || privateNode(node)) throw new Error('DREAM_CHANGE_SCOPE_UNAVAILABLE');
    }
    const queue = [scope.directory], rows: Array<{path: string; hash: string; text: string}> = [];
    let scanned = 0, directories = 0, bytes = 0;
    while (queue.length) {
        if (++directories > 32) throw new Error('DREAM_CHANGE_LIMIT');
        const parent = queue.shift()!, children = await fs.driver.getChildren(parent);
        scanned += children.length;
        if (scanned > scope.maxEntries) throw new Error('DREAM_CHANGE_LIMIT');
        for (const node of children) {
            const prefix = parent === '/' ? '/' : parent + '/';
            if (!node.path.startsWith(prefix) || !node.path.slice(prefix.length) || node.path.slice(prefix.length).includes('/')
                || node.path.slice(prefix.length) === '..' || node.path.includes('\\')) throw new Error('DREAM_CHANGE_SCOPE_INVALID');
            if (privateNode(node) || excluded(node.path, scope.exclude)) continue;
            if (node.type === 'directory') queue.push(node.path);
            else if (node.type === 'file' && documentPath(node.path)
                && (!scope.extensions?.length || scope.extensions.includes(node.path.split('.').at(-1)!.toLowerCase()))) {
                if (node.size > 32768) throw new Error('DREAM_CHANGE_LIMIT');
                const text = await fs.driver.readContent(node.path, {encoding: 'utf-8'});
                const after = await fs.driver.getNode(node.path);
                if (!after || nodeVersion(node) !== nodeVersion(after)) throw new Error('DREAM_CHANGE_SOURCE_CHANGED');
                bytes += new TextEncoder().encode(text).length;
                if (bytes > 32768) throw new Error('DREAM_CHANGE_LIMIT');
                rows.push({path: node.path, hash: sha256HexSync(text), text});
            }
        }
    }
    rows.sort((a, b) => a.path.localeCompare(b.path));
    const text = JSON.stringify(rows);
    if (new TextEncoder().encode(text).length > 32768) throw new Error('DREAM_CHANGE_LIMIT');
    return {text, scanned, directories};
}

function privateNode(node: FSNode): boolean {return !!node.metadata.isProtected || node.tags.includes('private');}
function excluded(path: string, exclude: string[]): boolean {
    return path.split('/').some(part => part.startsWith('.') || part === 'node_modules')
        || exclude.some(item => path === item || path.startsWith(item + '/'));
}

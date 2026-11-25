import type {DreamSource, SourceBatch, SourcePort} from '@nestos/dream';
import type {TwinSourceReader} from '../digital-twin/domain';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import {dreamRemoteSourcePort, type DreamRemoteSource} from './remote-source';

export interface DreamProjectFile extends DreamRemoteSource {capability: 'fileRead'; path: string}
export interface DreamProjectFilePort extends SourcePort<string> {target(source: DreamSource): string}

export function dreamProjectFilePort(remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>,
    file: DreamProjectFile, reader: Pick<TwinSourceReader, 'read'>): DreamProjectFilePort {
    const selected = {...file}, port = dreamRemoteSourcePort(remote, [selected], dreamProjectFileReader(reader, [selected]));
    return {...port, target(source) {
        if (selected.id !== source.id || selected.projectId !== source.projectId || selected.connectionId !== source.connectionId
            || selected.capability !== 'fileRead' || !validPath(selected.path)) throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        return fileTarget(selected);
    }};
}

/** Reuse the Twin reader's protected-file checks and version-stable read. */
export function dreamProjectFileReader(reader: Pick<TwinSourceReader, 'read'>, files: readonly DreamProjectFile[]) {
    const byId = new Map(files.map(file => [file.id, {...file}]));
    if (byId.size !== files.length) throw new Error('DREAM_DUPLICATE_SOURCE');
    return async (source: DreamRemoteSource, cursor: string | null, limit: number): Promise<SourceBatch<string>> => {
        const file = byId.get(source.id);
        if (!file || file.projectId !== source.projectId || file.connectionId !== source.connectionId
            || source.capability !== 'fileRead' || file.capability !== 'fileRead') throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        if (!Number.isSafeInteger(limit) || limit < 1 || !validPath(file.path)) throw new Error('DREAM_SOURCE_SCOPE');
        const content = await reader.read({kind: 'file', target: fileTarget(file), label: ''});
        const version = JSON.stringify([content.nativeIdentity, content.hash]);
        return {items: version === cursor ? [] : [content.text], cursor: version, version, scanned: 1};
    };
}
function fileTarget(file: DreamProjectFile): string {
    return `project://${encodeURIComponent(file.projectId)}${file.path.split('/').map(encodeURIComponent).join('/')}`;
}
function validPath(path: string): boolean {
    return typeof path === 'string' && path.startsWith('/') && path.length <= 1000 && !/[\\\0]/.test(path)
        && path.split('/').slice(1).every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'));
}

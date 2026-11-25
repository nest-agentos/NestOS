import type {DreamSource, SourceBatch, SourcePort} from '@nestos/dream';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DreamReadCapability} from '../projects/dream-authorization';

export interface DreamRemoteSource {
    id: string;
    projectId: string;
    connectionId: string;
    capability: DreamReadCapability;
}

/** The read adapter must enforce the supplied quota over its underlying scan. */
export function dreamRemoteSourcePort<T>(remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>,
    configured: readonly DreamRemoteSource[], read: (source: DreamRemoteSource, cursor: string | null, limit: number) => Promise<SourceBatch<T>>): SourcePort<T> {
    const definitions = new Map(configured.map(source => [source.id, {...source}]));
    if (definitions.size !== configured.length) throw new Error('DREAM_DUPLICATE_SOURCE');
    function definition(source: DreamSource): DreamRemoteSource {
        const value = definitions.get(source.id);
        if (!value || value.projectId !== source.projectId || value.connectionId !== source.connectionId)
            throw new Error('DREAM_SOURCE_BINDING_CHANGED');
        return value;
    }
    return {
        authorize: source => {
            const value = definition(source);
            return remote.authorizeDreamSource(value.projectId, value.connectionId, value.capability);
        },
        read: (source, limit) => read({...definition(source)}, source.cursor, limit),
    };
}

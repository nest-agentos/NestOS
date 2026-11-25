import {sameAuthority} from '@nestos/dream';
import {createModuleLogger} from '@nestos/common';
import type {Kernel} from '@nestos/durable-kernel';
import type {TwinSourceReader} from '../digital-twin/domain';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DreamConfigStore} from './config-store';
import type {DreamEvidenceStore} from './evidence-store';
import {dreamProjectFilePort} from './project-file-source';
import {runDreamTwinFileScan, type DreamTwinScanner} from './twin-scan';
import type {DreamExecutionRegistry} from './execution-registry';

export interface ConfiguredDreamRequest {ownerProjectId: string; dreamId: string; sourceId: string; operationId: string}
interface Dependencies {
    configs: DreamConfigStore; evidence: DreamEvidenceStore; twin: DreamTwinScanner; kernel: Pick<Kernel, 'task'>;
    registry: DreamExecutionRegistry;
    remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>; reader: Pick<TwinSourceReader, 'read'>;
    authorizeOwner(projectId: string): Promise<void>;
}
const log = createModuleLogger('dream-configured-scan');
export async function runConfiguredDreamFile(input: ConfiguredDreamRequest, dependencies: Dependencies): Promise<void> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.operationId) ? input.operationId : 'invalid';
    try {
        await executeConfigured(input, dependencies);
        log.info('dream.configured-scan', {operationId, stage: 'complete', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_CONFIGURATION_UNAVAILABLE';
        log.warn('dream.configured-scan', {operationId, stage: 'command', result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}
async function executeConfigured(input: ConfiguredDreamRequest, dependencies: Dependencies): Promise<void> {
    input = structuredClone(input);
    await dependencies.authorizeOwner(input.ownerProjectId);
    const record = await dependencies.configs.read(input.ownerProjectId, input.dreamId);
    const file = record?.config.files.find(item => item.id === input.sourceId);
    if (!record?.config.enabled || !file) throw new Error('DREAM_SOURCE_NOT_CONFIGURED');
    const port = dreamProjectFilePort(dependencies.remote, file, dependencies.reader);
    const base = {id: file.id, projectId: file.projectId, connectionId: file.connectionId, cursor: null};
    const authority = await port.authorize(base);
    const watermark = await dependencies.evidence.watermark(input.ownerProjectId, input.dreamId, file.id);
    if (watermark && (watermark.projectId !== file.projectId || watermark.connectionId !== file.connectionId
        || !sameAuthority(watermark.authority, authority))) throw new Error('DREAM_AUTHORIZATION_CHANGED');
    const previous = await dependencies.evidence.run(input.ownerProjectId, input.dreamId, input.operationId);
    const outcome = previous?.outcomes[0];
    if (previous && (previous.outcomes.length !== 1 || outcome?.status !== 'ok' || outcome.evidence.sourceId !== file.id))
        throw new Error('DREAM_OPERATION_CONFLICT');
    const cursor = outcome?.status === 'ok' ? outcome.evidence.startCursor : watermark?.cursor ?? null;
    const source = {...base, cursor};
    await runDreamTwinFileScan({ownerProjectId: input.ownerProjectId, dreamId: input.dreamId, operationId: input.operationId,
        planId: file.planId, planRevision: file.planRevision, twinSourceId: file.twinSourceId, target: port.target(source),
        source, configRevision: record.revision}, dependencies.twin, port, dependencies.evidence, dependencies.kernel,
        () => dependencies.authorizeOwner(input.ownerProjectId), (runId, authority) => dependencies.registry.bindRun(runId, {
            ownerProjectId: input.ownerProjectId, dreamId: input.dreamId, sourceId: file.id, configRevision: record.revision, authority}));
}

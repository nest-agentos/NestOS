import {sameAuthority} from '@nestos/dream';
import {createModuleLogger} from '@nestos/common';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DreamConfigStore} from './config-store';
import type {DreamExecutionBinding} from './execution-registry';

const log = createModuleLogger('dream-execution');

/** Revalidate the frozen source and owner when a scanner session resumes or exchanges data. */
export async function authorizeDreamExecution(sessionId: string, binding: DreamExecutionBinding, configs: DreamConfigStore,
    remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>, authorizeOwner: (owner: string) => Promise<void>,
    authorizeAdoption?: (binding: DreamExecutionBinding) => Promise<import('@nestos/dream').SourceAuthority>): Promise<void> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) ? sessionId : 'invalid';
    let stage = 'owner';
    try {
        if (operationId === 'invalid') throw new Error('DREAM_EXECUTION_ID_INVALID');
        await authorizeOwner(binding.ownerProjectId);
        stage = 'configuration';
        const config = await configs.read(binding.ownerProjectId, binding.dreamId);
        const source = config?.config.files.find(file => file.id === binding.sourceId);
        const adoption = config?.config.adoptions?.find(item => item.id === binding.sourceId);
        const decision = config?.config.decisions?.find(item => item.id === binding.sourceId);
        const task = config?.config.tasks?.find(item => item.id === binding.sourceId);
        const session = config?.config.sessions?.find(item => item.id === binding.sourceId);
        const change = config?.config.changes?.find(item => item.id === binding.sourceId);
        if (!config?.config.enabled || config.revision !== binding.configRevision || (!source && !adoption && !decision && !task && !session && !change)) throw new Error('DREAM_CONFIG_CONFLICT');
        stage = 'source';
        const authority = source ? await remote.authorizeDreamSource(source.projectId, source.connectionId, source.capability)
            : authorizeAdoption && binding.adoptionPlanRevision ? await authorizeAdoption(binding) : undefined;
        if (!authority) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        if (!sameAuthority(binding.authority, authority)) throw new Error('DREAM_AUTHORIZATION_CHANGED');
        stage = 'owner-recheck';
        await authorizeOwner(binding.ownerProjectId);
        stage = 'configuration-recheck';
        if ((await configs.read(binding.ownerProjectId, binding.dreamId))?.revision !== config.revision) throw new Error('DREAM_CONFIG_CONFLICT');
        log.info('dream.execution.authorize', {operationId, stage, result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message
            : stage === 'source' ? 'DREAM_AUTHORIZATION_UNAVAILABLE' : stage.startsWith('owner') ? 'DREAM_OWNER_AUTHORIZATION_FAILED' : 'DREAM_CONFIG_READ_FAILED';
        log.warn('dream.execution.authorize', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}

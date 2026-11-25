import type {DigitalTwinService} from '../digital-twin/service';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DreamConfigStore} from './config-store';
import type {DreamExecutionRegistry} from './execution-registry';
import type {DreamExecutionBinding} from './execution-registry';
import {authorizeDreamExecution} from './execution-authority';
import {createModuleLogger} from '@nestos/common';
const log = createModuleLogger('dream-execution');

/** Only a requested scanner session may cause its project workspace to be reopened. */
interface Dependencies {
    registry: DreamExecutionRegistry; configs: DreamConfigStore; remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>;
    authorizeOwner(owner: string): Promise<void>; open(owner: string, dream: string): Promise<DigitalTwinService>;
    authorizeAdoption?(binding: DreamExecutionBinding): Promise<import('@nestos/dream').SourceAuthority>;
}
export async function resolveDreamExecution(sessionId: string, dependencies: Dependencies, known?: DreamExecutionBinding): Promise<DigitalTwinService | null> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) ? sessionId : 'invalid';
    let stage = 'lookup';
    try {
        const binding = known ?? await dependencies.registry.find(sessionId);
        if (!binding) return null;
        const authorize = () => authorizeDreamExecution(sessionId, binding, dependencies.configs, dependencies.remote, dependencies.authorizeOwner, dependencies.authorizeAdoption);
        stage = 'authorization'; await authorize();
        stage = 'open'; const twin = await dependencies.open(binding.ownerProjectId, binding.dreamId);
        if (!await twin.ownsExecution(sessionId)) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        stage = 'revalidate'; await authorize();
        log.info('dream.execution.route', {operationId, stage, result: 'success', durationMs: Date.now() - started}); return twin;
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_EXECUTION_ROUTE_FAILED';
        log.warn('dream.execution.route', {operationId, stage, result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
    }
}

import type {TwinAnalysisJob} from '../digital-twin/domain';
import type {DigitalTwinService} from '../digital-twin/service';
import type {ProjectRemoteMountService} from '../projects/remote-mounts';
import type {DreamConfigStore} from './config-store';
import type {DreamExecutionBinding, DreamExecutionRegistry} from './execution-registry';
import {authorizeDreamExecution} from './execution-authority';
import {createModuleLogger} from '@nestos/common';
import {adoptionScannerIds} from './adoption-source';
const log = createModuleLogger('dream-execution');

interface Dependencies {
    registry: DreamExecutionRegistry; configs: DreamConfigStore; remote: Pick<ProjectRemoteMountService, 'authorizeDreamSource'>;
    twin: Pick<DigitalTwinService, 'bindScanner'>; authorizeOwner(owner: string): Promise<void>;
    authorizeAdoption?(binding: DreamExecutionBinding): Promise<import('@nestos/dream').SourceAuthority>;
}
type PreparationDependencies = Omit<Dependencies, 'twin'>;

/** Persist the parent session's route after the scanner has durably prepared its job. */
export async function prepareDreamExecution(job: TwinAnalysisJob, dependencies: PreparationDependencies): Promise<void> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.sessionId) ? job.sessionId : 'invalid';
    try {
        if (!job.scanScope?.runId) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        const binding = await dependencies.registry.findRun(job.scanScope.runId);
        if (!binding) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        await authorizeDreamExecution(job.sessionId, binding, dependencies.configs, dependencies.remote, dependencies.authorizeOwner, dependencies.authorizeAdoption);
        await validateJob(job, binding, dependencies.configs);
        await dependencies.registry.bind(job.sessionId, binding);
        log.info('dream.execution.job', {operationId, stage: 'prepare', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_EXECUTION_BINDING_FAILED';
        log.warn('dream.execution.job', {operationId, stage: 'prepare', result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
    }
}

export async function bindDreamExecutionFromRun(job: TwinAnalysisJob, executionSessionId: string, dependencies: Dependencies): Promise<void> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.sessionId) ? job.sessionId : 'invalid';
    try {
        if (!job.scanScope?.runId) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        const binding = await dependencies.registry.findRun(job.scanScope.runId);
        if (!binding) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        await bindDreamExecution(job, executionSessionId, binding, dependencies);
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_EXECUTION_BINDING_FAILED';
        log.warn('dream.execution.from-run', {operationId, stage: 'lookup', result: 'failure', code, durationMs: Date.now() - started}); throw new Error(code);
    }
}

/** Both routing identities are durable before the existing scanner submits a call. */
export async function bindDreamExecution(job: TwinAnalysisJob, executionSessionId: string, binding: DreamExecutionBinding, dependencies: Dependencies): Promise<void> {
    const started = Date.now(), operationId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(job.sessionId) ? job.sessionId : 'invalid';
    try {
        await bind(job, executionSessionId, binding, dependencies);
        log.info('dream.execution.prepare', {operationId, stage: 'bind', result: 'success', durationMs: Date.now() - started});
    } catch (error) {
        const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_EXECUTION_BINDING_FAILED';
        log.warn('dream.execution.prepare', {operationId, stage: 'bind', result: 'failure', code, durationMs: Date.now() - started});
        throw new Error(code);
    }
}
async function bind(job: TwinAnalysisJob, executionSessionId: string, binding: DreamExecutionBinding, dependencies: Dependencies): Promise<void> {
    const authorize = (id: string) => authorizeDreamExecution(id, binding, dependencies.configs, dependencies.remote, dependencies.authorizeOwner, dependencies.authorizeAdoption);
    await authorize(job.sessionId);
    await validateJob(job, binding, dependencies.configs);
    await dependencies.twin.bindScanner(job, executionSessionId);
    await dependencies.registry.bind(job.sessionId, binding);
    await dependencies.registry.bind(executionSessionId, binding);
    await authorize(executionSessionId);
}
async function validateJob(job: TwinAnalysisJob, binding: DreamExecutionBinding, configs: DreamConfigStore): Promise<void> {
    const config = await configs.read(binding.ownerProjectId, binding.dreamId);
    const file = config?.config.files.find(item => item.id === binding.sourceId);
    if (binding.retryPlan) {
        const plan = binding.retryPlan;
        if (!config?.config.enabled || config.revision !== binding.configRevision || job.sourceId !== plan.sourceId
            || job.scanScope?.sourceId !== plan.sourceId || job.scanScope.planId !== plan.planId
            || job.scanScope.planRevision !== plan.revision || !['queued', 'running'].includes(job.state))
            throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        return;
    }
    if (!file && (config?.config.adoptions?.some(item => item.id === binding.sourceId) || config?.config.decisions?.some(item => item.id === binding.sourceId) || config?.config.tasks?.some(item => item.id === binding.sourceId) || config?.config.sessions?.some(item => item.id === binding.sourceId) || config?.config.changes?.some(item => item.id === binding.sourceId)) && binding.adoptionPlanRevision) {
        const ids = adoptionScannerIds(binding.ownerProjectId, binding.dreamId, binding.sourceId);
        if (config.revision !== binding.configRevision || job.sourceId !== ids.twinSourceId || job.scanScope?.sourceId !== ids.twinSourceId
            || job.scanScope.planId !== ids.planId || job.scanScope.planRevision !== binding.adoptionPlanRevision
            || !['queued', 'running'].includes(job.state)) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
        return;
    }
    if (!file || config?.revision !== binding.configRevision || job.sourceId !== file.twinSourceId
        || job.scanScope?.sourceId !== file.twinSourceId || job.scanScope.planId !== file.planId
        || job.scanScope.planRevision !== file.planRevision || !['queued', 'running'].includes(job.state))
        throw new Error('DREAM_EXECUTION_BINDING_INVALID');
}

import {FSError, type IFileSystem} from '@nestos/vfs-core';
import {createModuleLogger} from '@nestos/common';
import type {SourceAuthority} from '@nestos/dream';

export interface DreamExecutionBinding {
    ownerProjectId: string; dreamId: string; sourceId: string; configRevision: number; authority: SourceAuthority;
    adoptionPlanRevision?: string;
}
const FILE = '/var/lib/dream/executions.seq';
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);
const log = createModuleLogger('dream-execution');

/** Metadata-only routing index; execution and receipts remain in the existing scanner. */
export class DreamExecutionRegistry {
    constructor(private readonly fs: IFileSystem) {}
    async find(sessionId: string): Promise<DreamExecutionBinding | null> {
        if (!validId(sessionId)) throw new Error('DREAM_EXECUTION_ID_INVALID');
        return this.read(JSON.stringify(sessionId));
    }
    async findRun(runId: string): Promise<DreamExecutionBinding | null> {
        if (!validId(runId)) throw new Error('DREAM_EXECUTION_ID_INVALID');
        return this.read('run:' + JSON.stringify(runId));
    }
    private async read(key: string): Promise<DreamExecutionBinding | null> {
        if (!await this.fs.driver.exists(FILE)) return null;
        const raw = await this.fs.meta.seq!.getEntry(FILE, key);
        if (!raw) return null;
        try {return validate(JSON.parse(raw) as DreamExecutionBinding);} catch {throw new Error('DREAM_EXECUTION_BINDING_INVALID');}
    }
    async bind(sessionId: string, binding: DreamExecutionBinding): Promise<void> {
        await this.bindKey(sessionId, JSON.stringify(sessionId), binding);
    }
    async bindRun(runId: string, binding: DreamExecutionBinding): Promise<void> {
        await this.bindKey(runId, 'run:' + JSON.stringify(runId), binding);
    }
    private async bindKey(id: string, key: string, binding: DreamExecutionBinding): Promise<void> {
        const started = Date.now();
        try {
            await this.writeBinding(id, key, binding);
            log.info('dream.execution.bind', {operationId: id, stage: 'commit', result: 'success', durationMs: Date.now() - started});
        } catch (error) {
            const code = error instanceof Error && /^DREAM_[A-Z_]+$/.test(error.message) ? error.message : 'DREAM_EXECUTION_BINDING_FAILED';
            log.warn('dream.execution.bind', {operationId: validId(id) ? id : 'invalid', stage: 'commit', result: 'failure', code, durationMs: Date.now() - started});
            throw new Error(code);
        }
    }
    private async writeBinding(id: string, key: string, binding: DreamExecutionBinding): Promise<void> {
        if (!validId(id)) throw new Error('DREAM_EXECUTION_ID_INVALID');
        const frozen = validate(structuredClone(binding)), encoded = JSON.stringify(frozen);
        try {await this.fs.driver.createFile({parentPath: '/var/lib/dream', name: 'executions.seq', type: 'seqfile', recursive: true});}
        catch (error) {if (!(error instanceof FSError) || error.code !== 'EEXIST') throw error;}
        await this.fs.meta.seq!.transaction!(async tx => {
            const existing = await tx.getEntry(FILE, key);
            if (existing && JSON.stringify(validate(JSON.parse(existing) as DreamExecutionBinding)) !== encoded) throw new Error('DREAM_EXECUTION_BINDING_CONFLICT');
            if (!existing) await tx.setEntry(FILE, key, encoded);
        });
    }
}
function validate(binding: DreamExecutionBinding): DreamExecutionBinding {
    if (!binding || !validId(binding.ownerProjectId) || !validId(binding.dreamId) || !validId(binding.sourceId)
        || !Number.isSafeInteger(binding.configRevision) || binding.configRevision < 1 || !binding.authority
        || binding.adoptionPlanRevision !== undefined && (typeof binding.adoptionPlanRevision !== 'string' || !binding.adoptionPlanRevision || binding.adoptionPlanRevision.length > 256)
        || !['principalId', 'revision', 'projectRevision', 'serverId', 'serverProjectId'].every(key => {
            const value = binding.authority[key as keyof SourceAuthority]; return typeof value === 'string' && value.length > 0 && value.length <= 4096;
        })) throw new Error('DREAM_EXECUTION_BINDING_INVALID');
    const a = binding.authority;
    return {ownerProjectId: binding.ownerProjectId, dreamId: binding.dreamId, sourceId: binding.sourceId, configRevision: binding.configRevision,
        authority: {principalId: a.principalId, revision: a.revision, projectRevision: a.projectRevision, serverId: a.serverId, serverProjectId: a.serverProjectId},
        ...(binding.adoptionPlanRevision ? {adoptionPlanRevision: binding.adoptionPlanRevision} : {})};
}

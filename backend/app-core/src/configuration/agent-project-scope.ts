import {createModuleLogger, randomUUID, sha256HexSync, t} from '@nestos/common';
import {FSError, type IVFSManager} from '@nestos/vfs-core';
import type {AgentProjectScope, ProjectService} from '@nestos/app-contracts/services';

export function validateAgentProjectScope(value: unknown): AgentProjectScope {
    const scope = value as AgentProjectScope;
    if (scope?.kind === 'all') return {kind: 'all'};
    if (scope?.kind !== 'selected' || !Array.isArray(scope.projectIds) || !scope.projectIds.length
        || scope.projectIds.some(id => typeof id !== 'string' || !id.trim()))
        throw Object.assign(new Error(t('agentWorkspace.selectOne')), {code: 'AGENT_PROJECT_SCOPE_INVALID'});
    return {kind: 'selected', projectIds: [...new Set(scope.projectIds)]};
}

const stores = new WeakMap<IVFSManager, AgentProjectScopes>();
export function agentProjectScopes(vfs: IVFSManager, projects: Pick<ProjectService, 'get'>): AgentProjectScopes {
    let store = stores.get(vfs);
    if (!store) {store = new AgentProjectScopes(vfs, projects); stores.set(vfs, store);}
    return store;
}

/** Read policy at admission; publication snapshots never preserve revoked project access. */
export class AgentProjectScopes {
    private tail = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    subscribe(listener: () => void): () => void {this.listeners.add(listener); return () => {this.listeners.delete(listener);};}
    constructor(private readonly vfs: IVFSManager, private readonly projects: Pick<ProjectService, 'get'>) {}
    private path(id: string): string {return `/agent-project-scopes/${sha256HexSync(id)}.json`;}
    async read(ids: string[], sessionId?: string): Promise<Record<string, AgentProjectScope>> {
        const operationId = randomUUID(), started = Date.now();
        try {
            await this.tail; const scopes = await this.readStored(ids);
            createModuleLogger('agent-project-scope').info('agent.project.read', {operation: 'agent.project.read', operationId,
                sessionId, count: ids.length, stage: 'storage.read-and-validate', result: 'success', durationMs: Date.now() - started});
            return scopes;
        } catch (error) {
            createModuleLogger('agent-project-scope').warn('agent.project.read', {operation: 'agent.project.read', operationId,
                sessionId, count: ids.length, stage: 'storage.read-and-validate', result: 'failure',
                code: scopeErrorCode(error, 'AGENT_PROJECT_SCOPE_READ_FAILED'), durationMs: Date.now() - started});
            throw error;
        }
    }
    private async readStored(ids: string[]): Promise<Record<string, AgentProjectScope>> {
        const fs = await this.vfs.openFileSystem('/etc');
        return Object.fromEntries(await Promise.all(ids.map(async id => {
            const path = this.path(id);
            if (!await fs.driver.exists(path)) return [id, {kind: 'all'}];
            const raw = await fs.driver.readContent(path, {encoding: 'utf-8'});
            try {return [id, validateAgentProjectScope(JSON.parse(String(raw)))];}
            catch {throw Object.assign(new Error(t('agentWorkspace.scopeRecordInvalid')), {code: 'AGENT_PROJECT_SCOPE_READ_FAILED'});}
        })));
    }
    save(id: string, value: AgentProjectScope): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        const snapshot = structuredClone(value);
        const pending = this.tail.then(async () => {
            const scope = validateAgentProjectScope(snapshot);
            if (scope.kind === 'selected') await Promise.all(scope.projectIds.map(project => this.projects.get(project)));
            const fs = await this.vfs.openFileSystem('/etc'), path = this.path(id), content = JSON.stringify(scope);
            if (await fs.driver.exists(path)) await fs.driver.writeContent(path, content);
            else await fs.driver.createFile({name: path.split('/').pop()!, parentPath: '/agent-project-scopes', content, recursive: true});
            return scope;
        });
        this.tail = pending.then(() => {}, () => {});
        return pending.then(scope => {
            for (const listener of this.listeners) {try {listener();} catch { /* Observers own their failures. */ }}
            createModuleLogger('agent-project-scope').info('agent.project.save', {operation: 'agent.project.save', operationId,
                stage: 'persist', result: 'success', kind: scope.kind, count: scope.kind === 'selected' ? scope.projectIds.length : 0, durationMs: Date.now() - started});
        }, error => {
            createModuleLogger('agent-project-scope').warn('agent.project.save', {operation: 'agent.project.save', operationId,
                stage: 'validate-and-persist', result: 'failure', code: scopeErrorCode(error, 'AGENT_PROJECT_SCOPE_SAVE_FAILED'), durationMs: Date.now() - started});
            throw error;
        });
    }
    async assert(id: string, projectId?: string, sessionId?: string): Promise<void> {
        const operationId = randomUUID(), started = Date.now();
        try {
            const scope = (await this.read([id], sessionId))[id]!;
            if (scope.kind === 'selected' && (!projectId || !scope.projectIds.includes(projectId)))
                throw Object.assign(new FSError('EACCES', t('agentWorkspace.scopeDenied')), {code: 'AGENT_PROJECT_SCOPE_DENIED'});
        } catch (error) {
            createModuleLogger('agent-project-scope').warn('agent.project.admit', {operation: 'agent.project.admit', operationId,
                agentId: id, projectId, sessionId, stage: 'policy.read-and-validate', result: 'failure',
                code: scopeErrorCode(error, 'AGENT_PROJECT_SCOPE_READ_FAILED'), durationMs: Date.now() - started});
            throw error;
        }
    }
}

function scopeErrorCode(error: unknown, fallback: string): string {
    const code = (error as {code?: unknown})?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

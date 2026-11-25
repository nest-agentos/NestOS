import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamConfigStore} from '../src/dream/config-store';
import {authorizeDreamExecution} from '../src/dream/execution-authority';
import {DreamExecutionRegistry} from '../src/dream/execution-registry';
import {resolveDreamExecution} from '../src/dream/execution-route';
import {bindDreamExecution, bindDreamExecutionFromRun} from '../src/dream/execution-bind';
import type {TwinAnalysisJob} from '../src/digital-twin/domain';

it('requires the original owner, source identity and configuration on session recovery', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs);
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: [file]}, {owner: async () => {}, source: async () => {}});
        const authority = {principalId: 'alice', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'project'};
        const binding = {ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'source', configRevision: 1, authority};
        const owner = async () => {}, remote = {authorizeDreamSource: async () => authority};
        await authorizeDreamExecution('session', binding, configs, remote as never, owner);
        await expect(authorizeDreamExecution('session', binding, configs, {authorizeDreamSource: async () => ({...authority, revision: '2'})} as never, owner))
            .rejects.toThrow('DREAM_AUTHORIZATION_CHANGED');
        await expect(authorizeDreamExecution('session', binding, configs, remote as never, async () => {throw new Error('private');}))
            .rejects.toThrow('DREAM_OWNER_AUTHORIZATION_FAILED');
        await configs.save('owner', 'dream', 'edit', 1, {name: 'Changed', enabled: true, files: [file]}, {owner: async () => {}, source: async () => {}});
        await expect(authorizeDreamExecution('session', binding, configs, remote as never, owner)).rejects.toThrow('DREAM_CONFIG_CONFLICT');
    } finally {await manager.dispose();}
});

it('binds both scanner sessions only for the frozen configured source', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs), registry = new DreamExecutionRegistry(fs);
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: [file]}, {owner: async () => {}, source: async () => {}});
        const authority = {principalId: 'alice', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'project'};
        const binding = {ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'source', configRevision: 1, authority};
        const bindScanner = vi.fn(async () => {}), deps = {registry, configs, twin: {bindScanner} as never,
            remote: {authorizeDreamSource: async () => authority} as never, authorizeOwner: async () => {}};
        const job = {sessionId: 'parent', sourceId: 'twin-source', state: 'queued',
            scanScope: {runId: 'run', sourceId: 'twin-source', planId: 'plan', planRevision: 'revision'}} as TwinAnalysisJob;
        await expect(bindDreamExecutionFromRun(job, 'child', deps)).rejects.toThrow('DREAM_EXECUTION_BINDING_INVALID');
        await registry.bindRun('run', binding);
        await bindDreamExecutionFromRun(job, 'child', deps);
        expect(await registry.find('parent')).toEqual(binding); expect(await registry.find('child')).toEqual(binding);
        expect(bindScanner).toHaveBeenCalledOnce();
        await expect(bindDreamExecution({...job, sourceId: 'other'}, 'different', binding, deps)).rejects.toThrow('DREAM_EXECUTION_BINDING_INVALID');
        expect(await registry.find('different')).toBeNull(); expect(bindScanner).toHaveBeenCalledOnce();
    } finally {await manager.dispose();}
});

it('opens only the bound workspace and rejects a revoked grant before opening it', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs), registry = new DreamExecutionRegistry(fs);
        const file = {id: 'source', projectId: 'project', connectionId: 'connection', capability: 'fileRead' as const,
            path: '/note.md', planId: 'plan', planRevision: 'revision', twinSourceId: 'twin-source'};
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: [file]}, {owner: async () => {}, source: async () => {}});
        const authority = {principalId: 'alice', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'project'};
        await registry.bind('session', {ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'source', configRevision: 1, authority});
        const twin = {ownsExecution: async (id: string) => id === 'session'};
        const open = vi.fn(async () => twin as never), deps = {registry, configs, open, authorizeOwner: async () => {},
            remote: {authorizeDreamSource: async () => authority} as never};
        expect(await resolveDreamExecution('unknown', deps)).toBeNull(); expect(open).not.toHaveBeenCalled();
        expect(await resolveDreamExecution('session', deps)).toBe(twin); expect(open).toHaveBeenCalledWith('owner', 'dream');
        open.mockClear();
        await expect(resolveDreamExecution('session', {...deps, remote: {authorizeDreamSource: async () => {throw new Error('private');}} as never}))
            .rejects.toThrow('DREAM_AUTHORIZATION_UNAVAILABLE');
        expect(open).not.toHaveBeenCalled();
    } finally {await manager.dispose();}
});

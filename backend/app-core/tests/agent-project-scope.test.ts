import {getLogger, sha256HexSync} from '@nestos/common';
import {it, expect, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {agentProjectScopes, validateAgentProjectScope} from '../src/configuration/agent-project-scope';

it('defaults old Agents to all projects and rejects empty or malformed selected scopes', () => {
    expect(validateAgentProjectScope({kind: 'all'})).toEqual({kind: 'all'});
    for (const value of [{kind: 'selected', projectIds: []}, {kind: 'selected', projectIds: ['']}, {kind: 'unknown'}, null])
        expect(() => validateAgentProjectScope(value)).toThrow();
});
it('persists immutable project identities, retains history access and rechecks revoked execution', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    let name = 'Before';
    const projects = {get: vi.fn(async (id: string) => ({name, project: {id}}))};
    const scopes = agentProjectScopes(manager, projects as never);
    try {
        expect(await scopes.read(['old'])).toEqual({old: {kind: 'all'}});
        await expect(scopes.assert('old', 'a')).resolves.toBeUndefined();
        await scopes.save('agent', {kind: 'selected', projectIds: ['a', 'a']}); name = 'Renamed';
        expect(await scopes.read(['agent'])).toEqual({agent: {kind: 'selected', projectIds: ['a']}});
        await expect(scopes.assert('agent', 'a')).resolves.toBeUndefined();
        await expect(scopes.assert('agent', 'b')).rejects.toMatchObject({code: 'AGENT_PROJECT_SCOPE_DENIED'});
        await expect(scopes.assert('agent')).rejects.toMatchObject({code: 'AGENT_PROJECT_SCOPE_DENIED'});
        await scopes.save('agent', {kind: 'selected', projectIds: ['b']});
        await expect(scopes.assert('agent', 'a')).rejects.toMatchObject({code: 'AGENT_PROJECT_SCOPE_DENIED'});
        expect(await scopes.read(['agent'])).toHaveProperty('agent');
        await scopes.save('agent', {kind: 'all'}); await expect(scopes.assert('agent', 'a')).resolves.toBeUndefined();
    } finally {await manager.dispose();}
});
it('fails closed on unreadable policy and never accepts an unknown project', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const store = agentProjectScopes(manager, {get: async () => {throw Object.assign(new Error('Unavailable'), {code: 'ENOENT'});}});
    try {
        await expect(store.save('agent', {kind: 'selected', projectIds: ['missing']})).rejects.toMatchObject({code: 'ENOENT'});
        expect(await store.read(['agent'])).toEqual({agent: {kind: 'all'}});
    } finally {await manager.dispose();}
});

it('publishes changes only after persistence and reports classified denial without content', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const scopes = agentProjectScopes(manager, {get: async () => ({})} as never), changed = vi.fn();
    const stop = scopes.subscribe(changed);
    try {
        await scopes.save('a', {kind: 'all'}); expect(changed).toHaveBeenCalledOnce();
        const fs = await manager.openFileSystem('/etc');
        await fs.driver.writeContent(`/agent-project-scopes/${sha256HexSync('a')}.json`, 'PRIVATE-CORRUPT-BODY');
        await expect(scopes.assert('a', 'p', 'session-correlation')).rejects.toThrow();
        const logs = getLogger().query({modules: ['agent-project-scope']}), serialized = JSON.stringify(logs);
        expect(serialized).toContain('AGENT_PROJECT_SCOPE_READ_FAILED');
        expect(serialized).toContain('session-correlation'); expect(serialized).toContain('durationMs');
        expect(serialized).not.toContain('PRIVATE-CORRUPT-BODY');
    } finally {stop(); await manager.dispose(); getLogger().clear();}
});

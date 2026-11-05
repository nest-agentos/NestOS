import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import type {MCPServer} from '@nestos/tools/mcp-contracts';
import {RemoteMountStore} from '../src/projects/remote-mount-store';
import {migrateCellsConnections} from '../src/configuration/migrate-cells-connections';
const close: Array<() => Promise<void>> = [];
afterEach(async () => {for (const fn of close.splice(0).reverse()) await fn();});
async function fixture() {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); close.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'), store = new RemoteMountStore(fs);
    const authorization = {principalId: 'owner', anonymous: false, revision: 'a'.repeat(64)};
    const mount = {mountId: 'root', at: '/', alias: 'x1', root: '/', access: 'rw' as const, connectionId: 'node', credentialRef: 'mcp-node',
        endpoint: 'http://node.test', serverId: 'server', authorization};
    await store.save({version: 1, revision: 1, connections: [], projects: {project: [mount]}});
    const legacy = {id: 'node', name: 'Cells', transport: 'http', endpoint: 'http://node.test/mcp', apiKey: 'fixture-secret',
        extensions: {'itookit/cells': {version: 1, httpEndpoint: 'http://node.test', mcpEndpoint: 'http://node.test/mcp',
            serverId: 'server', authorization, fileProtocol: 'fs-agent-http-v1', projects: true}}} as MCPServer;
    return {fs, legacy, mount};
}
it('moves referenced legacy Cells records and credentials into the canonical catalog exactly once', async () => {
    const {fs, legacy, mount} = await fixture();
    expect(await migrateCellsConnections(fs, [legacy])).toEqual(['node']);
    const store = new RemoteMountStore(fs), migrated = await store.load();
    expect(migrated!.connections![0]).toMatchObject({id: 'node', endpoint: 'http://node.test', serverId: 'server'});
    expect(migrated!.projects.project).toEqual([mount]); expect(store.password('node')).toBe('fixture-secret');
    expect(await migrateCellsConnections(fs, [legacy])).toEqual([]);
    expect((await new RemoteMountStore(fs).load())!.revision).toBe(migrated!.revision);
});
it('leaves the original mount intact when the legacy descriptor belongs to another server', async () => {
    const {fs, legacy, mount} = await fixture();
    (legacy.extensions!['itookit/cells'] as Record<string, unknown>).serverId = 'foreign';
    expect(await migrateCellsConnections(fs, [legacy])).toEqual([]);
    const state = await new RemoteMountStore(fs).load(); expect(state!.connections).toEqual([]); expect(state!.projects.project).toEqual([mount]);
});

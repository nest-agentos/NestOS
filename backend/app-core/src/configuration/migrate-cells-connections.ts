import {validateAuthorization} from '@nestos/cells-driver/authorization';
import type {MCPServer} from '@nestos/tools/mcp-contracts';
import type {IFileSystem} from '@nestos/vfs-core';
import {normalizeConnection, type RemoteFileSystemConfig} from '../projects/remote-connections';
import {RemoteMountStore} from '../projects/remote-mount-store';

/** One-time data import; normal Cells lookup never depends on MCP discovery or execution. */
export async function migrateCellsConnections(fs: IFileSystem, servers: MCPServer[], resolveCredential?: (id: string) => string | Promise<string>): Promise<string[]> {
    const store = new RemoteMountStore(fs); let catalog = await store.load();
    if (!catalog) return [];
    const imported: string[] = [], known = new Set((catalog.connections ?? []).flatMap(connection => connection?.id ? [connection.id] : []));
    const needed = new Set(Object.values(catalog.projects).flat().map(mount => mount?.connectionId).filter((id): id is string => !!id && !known.has(id)));
    for (const server of servers.filter(server => needed.has(server.id))) {
        const connection = legacyConnection(server);
        if (!connection) continue;
        const mounts = Object.values(catalog.projects).flat().filter(mount => mount?.connectionId === connection.id);
        if (!mounts.every(mount => mount.serverId === connection.serverId
            && mount.authorization?.principalId === connection.authorization?.principalId
            && mount.authorization?.anonymous === connection.authorization?.anonymous
            && mount.authorization?.revision === connection.authorization?.revision)) continue;
        const secret = server.apiKey || (server.auth?.credentialRef ? await resolveCredential?.(server.auth.credentialRef) : undefined);
        if (!secret && !connection.anonymous) continue;
        catalog = {...catalog, revision: catalog.revision + 1, connections: [...(catalog.connections ?? []).filter(connection => !!connection?.id), connection]};
        await store.save(catalog, secret ? {id: connection.id, password: secret} : undefined);
        imported.push(connection.id);
    }
    return imported;
}
function legacyConnection(server: MCPServer): RemoteFileSystemConfig | undefined {
    try {
        const value = server.extensions?.['itookit/cells'] as Record<string, unknown> | undefined;
        if (server.transport !== 'http' || value?.version !== 1 || value.fileProtocol !== 'fs-agent-http-v1'
            || typeof value.serverId !== 'string' || typeof value.httpEndpoint !== 'string' || value.mcpEndpoint !== server.endpoint) return;
        const authorization = validateAuthorization(value.authorization);
        if (!authorization || new URL(server.endpoint!).origin !== new URL(value.httpEndpoint).origin) return;
        const anonymous = server.auth?.type === 'anonymous';
        if (authorization.anonymous !== anonymous) return;
        return {...normalizeConnection({name: server.name, endpoint: value.httpEndpoint, anonymous,
            ...(server.auth?.type === 'basic' ? {username: server.auth.username} : {})}),
            id: server.id, serverId: value.serverId, authorization, projects: value.projects === true,
            credentialRef: server.auth?.credentialRef ?? 'mcp-' + server.id};
    } catch {return;}
}

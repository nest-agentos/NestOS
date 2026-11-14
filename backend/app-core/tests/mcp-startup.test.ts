import { expect, it, vi } from 'vitest';
import { MemoryBackend } from '@nestos/vfs-core';
import { createApplicationRuntime } from '../src/runtime/create-application-runtime';
import { mockMCPDiscovery } from './helpers/mcp-discovery';

async function startupFixture(mode: 'interactive' | 'server' = 'interactive') {
    const backend = new MemoryBackend();
    for (const path of ['/etc', '/etc/llm', '/etc/llm/.mcp']) await backend.mkdir(path);
    await backend.write('/etc/llm/.mcp/remote.json', new TextEncoder().encode(JSON.stringify({ id: 'remote', name: 'Remote',
        transport: 'http', endpoint: 'https://office.test/mcp', apiKey: 'test-key' })));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fetch = mockMCPDiscovery({ version: 1, httpEndpoint: 'https://office.test', serverId: 'office',
        fileProtocol: 'fs-agent-http-v1', harness: true, projects: true, projectProtocol: 'fs-agent-project-v1' });
    const transport = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (...args) => { await gate; return transport(...args); });
    const runtime = await createApplicationRuntime({ backend, ownerKind: 'cli', startupMode: mode, digitalTwinAutoStart: false,
        remoteSourceProvider: { setCredential() {}, dispose: async () => {}, open: async () => { throw new Error('not used'); } } });
    return { runtime, fetch, release };
}

it.each(['interactive', 'server'] as const)('keeps %s startup and Cells configuration independent of stalled MCP discovery', async mode => {
    const { runtime, fetch, release } = await startupFixture(mode);
    const remote = runtime.projects.remoteMounts!, changed = vi.fn();
    const stop = remote.onChange(changed);
    try {
        await runtime.llmDriver.ensureReady(); runtime.startBackground?.();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(remote.connections()).toEqual([]);
        release();
        await vi.waitFor(async()=>expect(await runtime.llmDriver.getMCPServers()).toEqual([expect.objectContaining({id:'remote',status:'connected'})]));
        expect(remote.connections()).toEqual([]);expect(changed).not.toHaveBeenCalled();
    } finally { release(); stop(); await runtime.dispose(); fetch.mockRestore(); }
});

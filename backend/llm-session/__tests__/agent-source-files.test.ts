import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {VFSAgentService} from '../src/services/vfs-agent-service';
import {createSessionHost} from '../src/utils/host-ports';
import {readAgentSources} from '../src/services/agent-source-files';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks();});

async function fixture(count: number) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const root = await manager.openFileSystem('/');
    await root.driver.createDirectory({name: 'agents', parentPath: '/'});
    const fs = await manager.openFileSystem('/agents');
    await fs.driver.createFile({name: '.defaults_version.json', parentPath: '/', content: '{"version":1}'});
    for (let index = 0; index < count; index++) {
        const id = 'agent-' + String(index).padStart(3, '0');
        await fs.driver.createFile({name: id + '.agent', parentPath: '/default', recursive: true,
            content: JSON.stringify({id, name: id, type: 'agent', config: {systemPrompt: 'PRIVATE_POLICY'}})});
    }
    const host = createSessionHost(), logger = {...host.logger, info: vi.fn(), warn: vi.fn()};
    const service = () => {
        const value = new VFSAgentService(fs, {getConfigVersion: () => 1, onChange: () => () => {}} as never, {...host, logger});
        cleanup.push(() => value.dispose()); return value;
    };
    return {fs, service, logger};
}

it('loads definitions past the search page after a fresh service and keeps exact published identity', async () => {
    const f = await fixture(67), first = f.service();
    expect((await f.fs.driver.search({type: 'file', name: {endsWith: '.agent'}})).nodes).toHaveLength(50);
    await first.init();
    const state = await first.getAgentPublicationStatus('agent-066');
    const revision = await first.publishAgent({agentId: 'agent-066', operationId: 'publish-last', expectedSourceDigest: state.sourceDigest,
        expectedRevisionDigest: state.draftDigest, expectedPublishedVersion: null});
    await first.dispose();
    const restored = f.service(); await restored.init();
    expect(await restored.getAgents()).toHaveLength(67);
    expect((await restored.getAgentConfig('agent-066'))?.id).toBe('agent-066');
    expect((await restored.getAgentRevision('agent-066', revision.target.version))?.target).toEqual(revision.target);
});

it('bounds definition reads and isolates malformed records without logging their content', async () => {
    const f = await fixture(21), read = f.fs.driver.readContent.bind(f.fs.driver); let active = 0, peak = 0;
    await f.fs.driver.createFile({name: 'broken.agent', parentPath: '/default', content: '{PRIVATE_INVALID_BODY'});
    vi.spyOn(f.fs.driver, 'readContent').mockImplementation(async (...args) => {
        active++; peak = Math.max(peak, active);
        try {await Promise.resolve(); return await read(...args);} finally {active--;}
    });
    const service = f.service(); await service.init();
    expect(await service.getAgents()).toHaveLength(21); expect(peak).toBeLessThanOrEqual(8);
    expect(f.logger.warn).toHaveBeenCalledWith('Agent definition skipped', expect.objectContaining({stage: 'decode', code: 'AGENT_DEFINITION_INVALID'}));
    expect(JSON.stringify([f.logger.info.mock.calls, f.logger.warn.mock.calls])).not.toMatch(/PRIVATE_/);
});

it('consumes every search page when tree enumeration is unavailable and tolerates diagnostic failure', async () => {
    const f = await fixture(21), search = vi.fn(query => f.fs.driver.search({...query, limit: 7}));
    const fs = {...f.fs, driver: {...f.fs.driver, walkTree: undefined, search}};
    f.logger.info.mockImplementation(() => {throw new Error('Diagnostic failure');});
    const sources = await readAgentSources(fs, f.logger);
    expect(sources).toHaveLength(21); expect(sources.at(-1)?.id).toBe('agent-020');
    expect(search.mock.calls.map(([query]) => query.offset)).toEqual([0, 7, 14]);
});

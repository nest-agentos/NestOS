import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamExecutionRegistry} from '../src/dream/execution-registry';

it('persists only stable routing metadata and rejects identity rebinding', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), first = new DreamExecutionRegistry(fs), second = new DreamExecutionRegistry(fs);
        const binding = {ownerProjectId: 'owner', dreamId: 'dream', sourceId: 'source', configRevision: 1,
            authority: {principalId: 'alice', revision: '1', projectRevision: '2', serverId: 'node', serverProjectId: 'project'}};
        expect(await first.find('session')).toBeNull();
        await first.bind('session', binding); await second.bind('session', binding);
        await first.bindRun('run', binding); await second.bindRun('run', binding);
        expect(await first.findRun('run')).toEqual(binding);
        await expect(first.bindRun('run', {...binding, sourceId: 'other'})).rejects.toThrow('DREAM_EXECUTION_BINDING_CONFLICT');
        expect(await second.find('session')).toEqual(binding);
        await expect(second.bind('session', {...binding, dreamId: 'other'})).rejects.toThrow('DREAM_EXECUTION_BINDING_CONFLICT');
        expect(await first.find('session')).toEqual(binding);
    } finally {await manager.dispose();}
});

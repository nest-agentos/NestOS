import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamConfigStore} from '../src/dream/config-store';
import {DreamSessionMemoryStore} from '../src/dream/session-memory-store';

it('fences session memory bindings and preserves stable receipts across unbind and rebind', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs), store = new DreamSessionMemoryStore(fs);
        const config = {name: 'Dream', enabled: true, files: []}, allow = {owner: async () => {}, source: async () => {}};
        await configs.save('owner', 'dream', 'create', null, config, allow);
        const input = {owner: 'owner', dream: 'dream', runId: 'run', sourceIds: ['source'], configRevision: 1};
        expect(await store.bind('session', 'bind', null, input)).toEqual({revision: 1});
        expect(await store.bind('session', 'bind', null, input)).toEqual({revision: 1});
        await expect(store.bind('session', 'bind', null, {...input, runId: 'other'})).rejects.toThrow('DREAM_OPERATION_CONFLICT');
        expect(await store.unbind('session', 'unbind', 1)).toEqual({revision: 2});
        expect(await store.unbind('session', 'unbind', 1)).toEqual({revision: 2});
        await expect(store.bind('session', 'stale', null, input)).rejects.toThrow('DREAM_SESSION_BINDING_CONFLICT');
        await configs.save('owner', 'dream', 'change', 1, {...config, name: 'Changed'}, allow);
        await expect(store.bind('session', 'new', 2, input)).rejects.toThrow('DREAM_CONFIG_CONFLICT');
        expect(await store.read('session')).toEqual({revision: 2, disabled: true});
    } finally {await manager.dispose();}
});

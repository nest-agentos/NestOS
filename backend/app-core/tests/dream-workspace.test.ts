import {expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {DreamConfigStore} from '../src/dream/config-store';
import {openDreamSystemWorkspace} from '../src/dream/workspace';

it('places the scanner system namespace under its owner project and denies unapproved owners', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    try {
        const fs = await manager.openFileSystem('/'), configs = new DreamConfigStore(fs);
        await configs.save('owner', 'dream', 'config', null, {name: 'Dream', enabled: true, files: []}, {owner: async () => {}, source: async () => {}});
        await expect(openDreamSystemWorkspace(fs, 'owner', 'dream', async () => {throw new Error('private');}))
            .rejects.toThrow('DREAM_OWNER_AUTHORIZATION_FAILED');
        const workspace = await openDreamSystemWorkspace(fs, 'owner', 'dream', async () => {});
        try {
            await workspace.fs.driver.createFile({parentPath: '/var/lib/digital-twin/internal', name: 'record', content: 'value', recursive: true});
            expect(await fs.driver.exists('/var/lib/projects/owner/dream/dream/var/lib/digital-twin/internal/record')).toBe(true);
            expect(await fs.driver.exists('/var/lib/digital-twin/internal/record')).toBe(false);
        } finally {await workspace.dispose();}
    } finally {await manager.dispose();}
});

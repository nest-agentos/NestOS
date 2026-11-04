import {afterEach, expect, it} from 'vitest';
import {createVFS, MemoryBackend} from '@itookit/vfs-core';
import {maintenanceResources, maintenancePrompts} from '../src/presets/kanban-maintenance';
import {readPrompt} from '../src/run/prompt-bundle';
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close();});
it('offers one recoverable prompt set, restores missing files and explicitly replaces custom versions', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); closes.push(() => manager.dispose()); const fs = await manager.openFileSystem('/');
    const api = maintenanceResources(fs), id = 'kanban:maintenance-prompts'; expect((await api.list())[0]).toMatchObject({id, exists: false, overwrite: true, group: 'kanban'});
    await api.restore(id); expect((await api.list())[0].exists).toBe(true);
    const path = '/var/lib/kanban/policies/development/task-build-pre.md'; await fs.driver.writeContent(path, 'Custom');
    expect(await readPrompt(fs, path)).toBe('Custom'); await api.restore(id); expect(await readPrompt(fs, path)).toBe(maintenancePrompts['task-build-pre.md']);
});

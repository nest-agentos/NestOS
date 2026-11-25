import {expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {readChangeSnapshot} from '../src/dream/change-source';

it('reads only the selected tree, excludes subtrees, and changes its digest on modification', async () => {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()});
    const fs = await manager.openFileSystem('/');
    try {
        await fs.driver.createFile({parentPath: '/chosen', name: 'one.md', content: 'one', recursive: true});
        await fs.driver.createFile({parentPath: '/chosen/skip', name: 'secret.md', content: 'secret', recursive: true});
        await fs.driver.createFile({parentPath: '/other', name: 'other.md', content: 'other', recursive: true});
        const list = vi.spyOn(fs.driver, 'getChildren');
        const scope = {directory: '/chosen', exclude: ['/chosen/skip'], maxEntries: 10};
        const first = await readChangeSnapshot(fs, scope);
        expect(first).toMatchObject({scanned: 4, directories: 2});
        expect(first.text).toContain('/chosen/one.md'); expect(first.text).not.toContain('secret');
        expect(list.mock.calls.map(call => call[0])).toEqual(['/chosen', '/chosen']);
        expect((await readChangeSnapshot(fs, scope)).hash).toBe(first.hash);
        await fs.driver.writeContent('/chosen/one.md', 'two');
        expect((await readChangeSnapshot(fs, scope)).hash).not.toBe(first.hash);
        const markdownOnly = await readChangeSnapshot(fs, {...scope, extensions: ['md']});
        await fs.driver.createFile({parentPath: '/chosen', name: 'ignored.ts', content: 'excluded by extension'});
        expect((await readChangeSnapshot(fs, {...scope, extensions: ['md']})).hash).toBe(markdownOnly.hash);
        await expect(readChangeSnapshot(fs, {...scope, maxEntries: 1})).rejects.toThrow('DREAM_CHANGE_LIMIT');
        await expect(readChangeSnapshot(fs, {...scope, exclude: ['/other']})).rejects.toThrow('DREAM_CHANGE_SCOPE_INVALID');
    } finally {await manager.dispose();}
});

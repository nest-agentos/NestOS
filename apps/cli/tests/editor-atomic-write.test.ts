// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFsOps } from '@itookit/vfsdriver-local/node';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), 'localfs-atomic-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('retries editor content through the real atomic writer after publication failure', async () => {
    const { MDxEditor } = await import('@itookit/mdxeditor');
    const path = join(root, 'document.md');
    await fs.writeFile(path, 'original');
    const writer = new NodeFsOps();
    const editor = new MDxEditor({ onSave: content => writer.writeFile(path, new TextEncoder().encode(content).buffer) });
    const container = document.createElement('div');
    await editor.init(container, 'edited');
    const onError = vi.fn(), onSuccess = vi.fn();
    editor.on('saveError', onError); editor.on('saved', onSuccess);
    editor.setDirty(true);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('publication failed'));
    await editor.save();
    expect(editor.isDirty()).toBe(true);
    expect(await fs.readFile(path, 'utf8')).toBe('original');
    editor.setText('newer edit'); editor.setDirty(true);
    await editor.save();
    expect(editor.isDirty()).toBe(false);
    expect(await fs.readFile(path, 'utf8')).toBe('newer edit');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(root)).toEqual(['document.md']);
    await editor.destroy();
});

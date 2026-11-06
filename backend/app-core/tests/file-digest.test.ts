import {afterEach, expect, it, vi} from 'vitest';
import {createVFS, MemoryBackend} from '@nestos/vfs-core';
import {sha256HexSync} from '@nestos/common';
import {verifyFileDigest} from '../src/run/file-digest';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close();});
async function fixture(content: string) {
    const {manager} = await createVFS({rootBackend: new MemoryBackend()}); cleanup.push(() => manager.dispose());
    const fs = await manager.openFileSystem('/'); await fs.driver.createFile({parentPath: '/', name: 'evidence', content});
    return fs;
}
it('verifies artifact manifests above the prompt limit with one bounded content read', async () => {
    const content = JSON.stringify({files: Array.from({length: 1000}, (_, i) => ({path: 'module/' + i, hash: 'a'.repeat(64)}))});
    const fs = await fixture(content), read = vi.spyOn(fs.driver, 'readContent');
    await verifyFileDigest(fs, '/evidence', sha256HexSync(content), 8 * 1024 * 1024);
    expect(read).toHaveBeenCalledExactlyOnceWith('/evidence', {encoding: 'binary', length: new TextEncoder().encode(content).byteLength});
});
it('rejects an oversized artifact before reading its contents and reports safe size metadata', async () => {
    const fs = await fixture('private artifact contents'), read = vi.spyOn(fs.driver, 'readContent'), log = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verifyFileDigest(fs, '/evidence', '0'.repeat(64), 4, 'operation')).rejects.toMatchObject({code: 'OPERATION_RESULT_ARTIFACT_LIMIT'});
    expect(read).not.toHaveBeenCalled(); expect(JSON.stringify(log.mock.calls)).not.toContain('private artifact contents');
    expect(JSON.stringify(log.mock.calls)).toContain('maxBytes');
});
it('rejects a valid-sized artifact with the wrong digest', async () => {
    const fs = await fixture('valid file'); vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(verifyFileDigest(fs, '/evidence', '0'.repeat(64), 1024)).rejects.toMatchObject({code: 'OPERATION_RESULT_ARTIFACT_UNVERIFIED'});
});
it('rejects changes between metadata reads instead of accepting a stale digest', async () => {
    const fs = await fixture('original'), original = fs.driver.readContent.bind(fs.driver);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(fs.driver, 'readContent').mockImplementation(async (...args: Parameters<typeof original>) => {
        const data = await original(...args); await fs.driver.writeContent('/evidence', 'changed'); return data;
    });
    await expect(verifyFileDigest(fs, '/evidence', sha256HexSync('original'), 1024)).rejects.toMatchObject({code: 'ARTIFACT_READ_CONFLICT'});
});

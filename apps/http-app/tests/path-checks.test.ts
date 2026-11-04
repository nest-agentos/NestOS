import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PathChecks} from '../../node-host/src/storage/path-checks';
import {UserFiles} from '../../node-host/src/storage/user-files';

const directories: string[] = [];
afterEach(async () => {vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive: true, force: true})));});
async function fixture() {
    const home = await mkdtemp(path.join(tmpdir(), 'nestos-path-policy-')); directories.push(home);
    const state = path.join(home, '.nestos/state'); await mkdir(path.join(home, 'docs'), {recursive: true});
    await writeFile(path.join(home, 'docs/a.txt'), 'safe');
    const logical = path.join(state, 'home/admin/docs/a.txt');
    return {home, state, logical};
}
it('shares physical probes within a batch and reads new facts after the batch ends', async () => {
    const {home} = await fixture(), inspect = vi.fn(async (_value: string) => ({isSymbolicLink: () => false}) as never);
    const checks = new PathChecks(inspect), probes = new Map();
    await Promise.all([checks.check(home, path.join(home, 'docs/a.txt'), probes), checks.check(home, path.join(home, 'docs/b.txt'), probes)]);
    expect(inspect.mock.calls.map(([value]) => value)).toEqual([path.join(home, 'docs'), path.join(home, 'docs/a.txt'), path.join(home, 'docs/b.txt')]);
    await checks.check(home, path.join(home, 'docs/a.txt'));
    expect(inspect).toHaveBeenCalledTimes(5);
});
it('revalidates a replaced ancestor in strict mode and rejects reads and writes through it', async () => {
    const {home, state, logical} = await fixture(), files = new UserFiles(state, home, true);
    expect(new TextDecoder().decode((await files.readFile(logical))!)).toBe('safe');
    await rename(path.join(home, 'docs'), path.join(home, 'original'));
    await symlink(path.join(home, 'original'), path.join(home, 'docs'));
    await expect(files.readFile(logical)).rejects.toMatchObject({code: 'EACCES'});
    await expect(files.writeFile(logical, new TextEncoder().encode('blocked').buffer)).rejects.toMatchObject({code: 'EACCES'});
    expect(await readFile(path.join(home, 'original/a.txt'), 'utf8')).toBe('safe');
});
it('skips physical prefix walks in normal mode while retaining lexical user boundaries', async () => {
    const {home, state, logical} = await fixture(), checks = vi.spyOn(PathChecks.prototype, 'check'), files = new UserFiles(state, home, false);
    expect(new TextDecoder().decode((await files.readFile(logical))!)).toBe('safe');
    expect((await files.statMany([logical, logical]))[0]?.isFile).toBe(true);
    expect(checks).not.toHaveBeenCalled();
    await expect(files.readFile(path.join(home, '../outside'))).rejects.toMatchObject({code: 'EACCES'});
    await expect(files.readFile(path.join(state, 'home/admin/.nestos/private'))).rejects.toMatchObject({code: 'EACCES'});
});

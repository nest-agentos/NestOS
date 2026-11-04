import {spawnSync} from 'node:child_process';
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadNodeToolModules} from '../src/runtime/tool-modules';
const supported = process.platform === 'linux' && spawnSync('/usr/bin/bwrap', ['--unshare-user', '--unshare-pid', '--die-with-parent', '--dev-bind', '/', '/', '--proc', '/proc', '--', '/bin/true'], {timeout: 5000}).status === 0;
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => {for (const close of closes.splice(0).reverse()) await close(); vi.unstubAllEnvs();});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'temporary-tool-')); closes.push(() => rm(root, {recursive: true, force: true})); vi.stubEnv('XDG_STATE_HOME', root);
    const file = fileURLToPath(new URL('../../../tools/temporary-process/node/extension.mjs', import.meta.url));
    const [tool] = await loadNodeToolModules(JSON.stringify([file])); closes.push(async () => tool.dispose?.()); return {root, tool};
}
it.skipIf(!supported)('loads the external tool through the real factory and reconciles repeated calls without executing again', async () => {
    const {root, tool} = await fixture(), output = join(root, 'ran');
    const args = {command: process.execPath, args: ['-e', 'require("node:fs").appendFileSync(process.argv[1],"run");console.log("checked")', output], timeoutMs: 10000};
    const context = {operationId: 'stable-operation', record: vi.fn()} as never;
    const first = await tool.call(args, context), replay = await tool.call(args, context);
    expect(first.data).toMatchObject({outcome: 'succeeded', output: 'checked\n'}); expect(replay.data).toEqual(first.data);
    expect(await readFile(output, 'utf8')).toBe('run');
    await expect(tool.call({...args, args: ['-e', 'process.exit(0)']}, context)).rejects.toMatchObject({code: 'TEMP_PROCESS_OPERATION_CONFLICT'});
});
it.skipIf(!supported)('tool disposal cancels an active scope and rejects new admission', async () => {
    const {root, tool} = await fixture(), marker = join(root, 'started');
    const running = tool.call({command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"started");setInterval(()=>{},1000)', marker], timeoutMs: 10000}, {operationId: 'dispose-operation'} as never);
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('started'));
    await tool.dispose!(); expect((await running).data).toMatchObject({outcome: 'cancelled'});
    await expect(tool.call({command: process.execPath, args: [], timeoutMs: 1000}, {operationId: 'new-operation'} as never)).rejects.toMatchObject({code: 'TEMP_PROCESS_STOPPING'});
});
it.skipIf(!supported)('preinstalls the portable package through the registry while keeping per-user execution disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'temporary-registration-')); closes.push(() => rm(root, {recursive: true, force: true})); vi.stubEnv('XDG_STATE_HOME', root);
    const {NodeToolPackages} = await import('../src/runtime/tool-packages');
    const source = fileURLToPath(new URL('../../../tools/temporary-process', import.meta.url));
    const manager = new NodeToolPackages({directories: [source], env: {XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data')}});
    closes.push(() => manager.close()); await manager.initialize();
    expect(await manager.list()).toMatchObject([{id: 'temporary-process', status: 'registered', configuration: {enabled: false}}]);
    const [tool] = manager.userTools(manager.initialTools()); expect(tool.isEnabled()).toBe(false);
});

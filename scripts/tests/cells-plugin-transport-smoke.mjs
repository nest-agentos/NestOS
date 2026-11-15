import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {withTemporaryScope, processOutput} from '../../tools/temporary-process/node/index.mjs';

async function readyEndpoint(server) {
    let endpoint;
    const deadline = Date.now() + 10000;
    while (!endpoint && Date.now() < deadline) {
        const {output} = await processOutput(undefined, server.id);
        const ready = output.split('\n').flatMap(line => {try {return [JSON.parse(line)];} catch {return [];}})
            .find(row => row.event === 'server.ready');
        if (ready) endpoint = 'http://' + ready.fields.address;
        else await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(endpoint, 'server did not become ready');
    return endpoint;
}
async function verifyWrites(request, root) {
    const write = await request('/v1/fs/docs/content?path=created.txt', {method: 'PUT',
        headers: {'if-none-match': '*', 'x-operation-id': 'smoke-create'}, body: 'created'});
    assert.equal(write.status, 200);
    assert.equal((await write.json()).outcome, 'committed');
    const conflict = await request('/v1/fs/docs/content?path=created.txt', {method: 'PUT',
        headers: {'if-none-match': '*', 'x-operation-id': 'smoke-conflict'}, body: 'conflict'});
    assert.equal((await conflict.json()).outcome, 'not-committed');
    assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'created');
}

const binary = resolve(process.env.CELLS_BINARY ?? 'tools/cells/target/debug/cells');
const directory = await mkdtemp(join(tmpdir(), 'cells-plugin-transport-'));
const token = randomUUID();
let results;
try {
    const root = join(directory, 'files');
    await mkdir(root);
    await Promise.all(Array.from({length: 600}, (_, i) => writeFile(join(root, `file-${String(i).padStart(3, '0')}.txt`), 'a'.repeat(4096))));
    const config = join(directory, 'config.toml');
    await writeFile(config, `listen='127.0.0.1:0'\nexecution=false\nserver_id='smoke'\nlog_level='debug'\n[plugins]\nmcp=false\n[[principals]]\nid='smoke'\ntoken='${token}'\n[[exports]]\nalias='docs'\npath='${root}'\naccess='rw'\n[[exports.grants]]\nprincipal='smoke'\naccess='rw'\n`);
    await withTemporaryScope({scopeId: 'cells-plugin-transport-' + randomUUID()}, async scope => {
        const server = await scope.start(binary, [config], {timeoutMs: 45000});
        const endpoint = await readyEndpoint(server);
        let calls = 0;
        const request = async (path, options = {}) => {
            calls++;
            return fetch(endpoint + path, {...options, headers: {authorization: 'Bearer ' + token, ...options.headers}, signal: AbortSignal.timeout(10000)});
        };
        const scenario = async state => {
            calls = 0;
            const start = performance.now();
            assert.equal((await request('/v1/capabilities')).status, 200);
            assert.equal((await (await request('/v1/exports')).json()).exports[0].access, 'rw');
            const first = await (await request('/v1/fs/docs/entries?path=')).json();
            assert.equal(first.entries.length, 512);
            const second = await (await request('/v1/fs/docs/entries?path=&cursor=' + encodeURIComponent(first.nextCursor))).json();
            assert.equal(second.entries.length, 88);
            assert.equal(second.nextCursor, null);
            const stats = await (await request('/v1/fs/docs/stat', {method: 'POST', headers: {'content-type': 'application/json'},
                body: JSON.stringify({paths: first.entries.slice(0, 256).map(row => row.name)})})).json();
            assert.equal(stats.results.length, 256);
            assert.ok(stats.results.every(row => row.stat.size === 4096));
            const content = await request('/v1/fs/docs/content?path=file-000.txt', {headers: {range: 'bytes=100-199'}});
            assert.equal(content.status, 206);
            assert.equal((await content.arrayBuffer()).byteLength, 100);
            const elapsedMs = Math.round((performance.now() - start) * 100) / 100;
            assert.equal(calls, 6);
            assert.ok(elapsedMs < 5000);
            return {state, elapsedMs, logicalApiCalls: calls, httpRequests: calls};
        };
        results = [await scenario('cold-server-cache'), await scenario('warm-server-cache')];
        await verifyWrites(request, root);
        await Promise.all(Array.from({length: 10}, async () => {
            const response = await request('/v1/fs/docs/content?path=file-001.txt');
            assert.equal((await response.arrayBuffer()).byteLength, 4096);
        }));
        const {output} = await processOutput(undefined, server.id);
        assert.ok(output.includes('files.source'));
        assert.ok(!output.includes(token));
    });
    console.log(JSON.stringify({operation: 'cells.plugin-transport.smoke', result: 'success', cleanup: 'confirmed',
        binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
        files: 600, fileBytes: 4096, backgroundLoad: 'none within isolated node', scenarios: results,
        scope: 'file HTTP protocol; complete UI navigation is not measured'}));
} finally {
    await rm(directory, {recursive: true, force: true});
}

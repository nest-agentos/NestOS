import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processErrorMetadata} from '../httpd-diagnostics.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('fatal metadata retains bounded error categories and locations without exception contents', () => {
    const cause = Object.assign(new Error('private parameter and token'), {code: 'EIO'});
    const error = Object.assign(new TypeError('private user message'), {code: 'EFIXTURE', cause});
    cause.cause = error;
    error.stack = 'TypeError: private user message\n    at invoke (/app/server/main.js:12:3)\n    at node:internal/process/task_queues:105:5';
    const metadata = processErrorMetadata(error);
    assert.deepEqual(metadata.causeCodes, ['EFIXTURE', 'EIO']);
    assert.deepEqual(metadata.locations, ['/app/server/main.js:12:3', 'node:internal/process/task_queues:105:5']);
    assert.equal(metadata.errorName, 'TypeError');assert.equal(metadata.errorCode, 'EFIXTURE');
    assert.doesNotMatch(JSON.stringify(metadata), /private|token|parameter|user message/);
    assert.deepEqual(processErrorMetadata('private rejection value'), {errorName: undefined, errorCode: undefined, causeCodes: [], locations: []});
});

test('writes the final process receipt before an earlier registered log closer runs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'httpd-exit-receipt-')), file = path.join(root, 'exit.jsonl');
    try {
        const source = `import {appendFileSync} from 'node:fs';
            import {installProcessDiagnostics} from ${JSON.stringify(new URL('../httpd-diagnostics.mjs', import.meta.url).href)};
            let closed = false;process.once('exit', () => {closed = true;});
            installProcessDiagnostics({role:'launcher',version:'fixture'}, event => {
                if (closed) throw new Error('log already closed');appendFileSync(process.argv[1], JSON.stringify(event)+'\\n');
            });process.exit(7);`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', source, file], {stdio: 'ignore'});
        assert.equal((await once(child, 'exit'))[0], 7);
        const logs = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        const exit = logs.find(event => event.stage === 'process.exit');
        assert.equal(exit.exitCode, 7);assert.equal(exit.result, 'failure');
        assert.equal(exit.operationId, logs[0].operationId);
    } finally {await rm(root, {recursive: true, force: true});}
});

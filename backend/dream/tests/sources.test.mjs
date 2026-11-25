import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scanSources} from '../src/sources.ts';

const sources = ['a', 'b'].map(id => ({id, projectId: id, connectionId: 'connection', cursor: 'old'}));
const grant = {principalId: 'user', revision: 'grant-1', projectRevision: 'project-1', serverId: 'server', serverProjectId: 'remote'};

test('isolates a denied project and retains the other source evidence', async () => {
    const limits = [], diagnostics = [];
    const result = await scanSources(sources, 8, {
        async authorize(source) { if (source.id === 'a') throw Error('secret'); return grant; },
        async read(source, limit) { limits.push(limit); return {items: [source.id], scanned: 2, cursor: 'next', version: 'v1'}; },
    }, {operationId: 'run-1', emit: event => diagnostics.push(event)});
    assert.deepEqual(result[0], {status: 'failed', sourceId: 'a', code: 'AUTHORIZATION_FAILED'});
    assert.equal(result[1].status, 'ok');
    assert.deepEqual(result[1].evidence, {sourceId: 'b', projectId: 'b', connectionId: 'connection', authority: grant,
        startCursor: 'old', endCursor: 'next', version: 'v1', scanned: 2});
    assert.deepEqual(limits, [4]);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(diagnostics).includes('secret'));
    assert.deepEqual(diagnostics.map(event => [event.operationId, event.result, event.code]),
        [['run-1', 'failed', 'AUTHORIZATION_FAILED'], ['run-1', 'ok', undefined]]);
});

test('discards data and cursor when authorization changes during a read', async () => {
    let calls = 0;
    const result = await scanSources([sources[0]], 2, {
        async authorize() { return {...grant, revision: ++calls === 1 ? 'old' : 'new'}; },
        async read() { return {items: ['private'], scanned: 1, cursor: 'next', version: 'v1'}; },
    });
    assert.deepEqual(result, [{status: 'failed', sourceId: 'a', code: 'AUTHORIZATION_CHANGED'}]);
});

test('discards a batch when the remote project binding changes without a revision change', async () => {
    let calls = 0;
    const result = await scanSources([sources[0]], 2, {
        async authorize() { return {...grant, serverProjectId: ++calls === 1 ? 'remote' : 'other'}; },
        async read() { return {items: ['private'], scanned: 1, cursor: 'next', version: 'v1'}; },
    });
    assert.deepEqual(result, [{status: 'failed', sourceId: 'a', code: 'AUTHORIZATION_CHANGED'}]);
});

test('rejects over-budget receipts and accounts for skipped sources', async () => {
    const port = {async authorize() { return grant; }, async read() { return {items: [], scanned: 2, cursor: null, version: 'v1'}; }};
    const result = await scanSources(sources, 1, port);
    assert.deepEqual(result, [{status: 'failed', sourceId: 'a', code: 'INVALID_BATCH'},
        {status: 'skipped', sourceId: 'b', code: 'BUDGET_EXHAUSTED'}]);
});

test('freezes all selected source identities before any asynchronous read', async () => {
    const inputs = sources.map(source => ({...source}));
    const seen = [];
    await scanSources(inputs, 2, {
        async authorize(source) { seen.push(source.projectId); return grant; },
        async read(source) { if (source.id === 'a') inputs[1].projectId = 'other';
            return {items: [], scanned: 0, cursor: null, version: 'v1'}; },
    });
    assert.deepEqual(seen, ['a', 'a', 'b', 'b']);
});

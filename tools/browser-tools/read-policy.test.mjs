import assert from 'node:assert/strict';
import test from 'node:test';
import { nestosReadRequest } from './read-policy.mjs';

function allowed(path, method, body, header) {
    return nestosReadRequest({
        method: () => method,
        postDataJSON: () => JSON.parse(body),
        postData: () => body,
        headers: () => header ? {'x-view-call': encodeURIComponent(JSON.stringify(header))} : {},
    }, new URL(path, 'https://127.0.0.1:2000'));
}

test('read permission accepts the NestOS query protocol and blocks mutations', () => {
    assert.equal(allowed('/', 'GET'), true);
    assert.equal(allowed('/assets/app.js', 'GET'), true);
    assert.equal(allowed('/api/application', 'POST', '{"kind":"queries"}'), true);
    assert.equal(allowed('/api/application', 'POST', '{"kind":"call"}'), false);
    assert.equal(allowed('/api/application', 'POST', '{'), false);
    assert.equal(allowed('/api/tool-connections/callback', 'GET'), false);
    assert.equal(allowed('/api/application/files', 'POST', '', {method: 'readContent'}), true);
    assert.equal(allowed('/api/application/files', 'POST', 'data', {method: 'writeContent'}), false);
});

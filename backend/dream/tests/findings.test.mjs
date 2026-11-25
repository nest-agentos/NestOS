import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDerivedFindings} from '../src/findings.ts';

test('keeps inferred memories and suggestions labelled and requires source evidence', () => {
    const row = {kind: 'inference', content: 'Possible preference', quote: 'uses TypeScript', subject: 'self', project: '', eventTime: ''};
    assert.deepEqual(parseDerivedFindings({dreamFindings: [row]}, 'Alice uses TypeScript.'), [row]);
    assert.deepEqual(parseDerivedFindings({candidates: []}, 'source'), []);
    assert.throws(() => parseDerivedFindings({dreamFindings: [{...row, quote: 'fabricated'}]}, 'source'), /DREAM_RESULT_UNSUPPORTED/);
    assert.throws(() => parseDerivedFindings({dreamFindings: [{...row, kind: 'fact'}]}, 'Alice uses TypeScript.'), /DREAM_RESULT_UNSUPPORTED/);
});

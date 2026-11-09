import {expect, it} from 'vitest';
import {flowRunOutputPreview, flowRunPreview} from '../src/flow/run-preview';

it('preserves scalar values and bounds long Unicode text without splitting a surrogate pair', () => {
    expect(flowRunPreview(undefined)).toBeUndefined();
    expect(flowRunPreview(null)).toEqual({text: 'null', truncated: false});
    expect(flowRunPreview(false)).toEqual({text: 'false', truncated: false});
    expect(flowRunPreview(0)).toEqual({text: '0', truncated: false});
    const preview = flowRunPreview('a'.repeat(599) + '😀' + 'b'.repeat(2000))!;
    expect(preview.truncated).toBe(true); expect(preview.text).toHaveLength(599);
    expect(preview.text).not.toMatch(/[\uD800-\uDBFF]$/);
});

it('bounds object breadth, depth and traversal while leaving persisted values unchanged', () => {
    const input = {essay: '<untrusted text>', empty: '', enabled: false, count: 0};
    expect(flowRunPreview(input)).toMatchObject({truncated: false, text: expect.stringContaining('<untrusted text>')});
    const deep = {one: {two: {three: {four: {value: 'too deep'}}}}};
    expect(flowRunPreview(deep)?.truncated).toBe(true);
    const large = Array.from({length: 10000}, () => ({text: 'x'.repeat(10000)}));
    const preview = flowRunPreview(large)!;
    expect(preview.truncated).toBe(true); expect(preview.text.length).toBeLessThanOrEqual(600);
    expect(large).toHaveLength(10000); expect(large[0].text).toHaveLength(10000);
});

it('shows bounded artifact values and marks omitted nodes instead of hiding them behind envelopes', () => {
    const node = {outputs: {result: {outputName: 'result', type: 'text', content: 'Actual output'}}};
    expect(flowRunOutputPreview({nodes: {node}})).toEqual({text: '{\n  "node / result": "Actual output"\n}', truncated: false});
    expect(flowRunOutputPreview({nodes: {a: node, b: node, c: node, d: node, e: node}})?.truncated).toBe(true);
});

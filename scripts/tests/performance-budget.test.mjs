import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessPerformance, createPerformanceMeasurement} from '../performance-budget.mjs';
const sample = overrides => ({scope: 'session-api-ready', dataset: 'fixture-100-rounds', completed: true,
    durationMs: 4999, apiCalls: 29, httpRequests: 4, unknownRequests: 0, ...overrides});
test('requires both strict time and API-count limits', () => {
    assert.equal(assessPerformance(sample()).passed, true);
    for (const change of [{durationMs: 5000}, {apiCalls: 30}, {durationMs: 1, apiCalls: 31}, {durationMs: 5001, apiCalls: 1}])
        assert.equal(assessPerformance(sample(change)).passed, false);
});
test('counts logical calls inside one HTTP batch, bindings, failures and bootstrap', () => {
    let now = 0; const meter = createPerformanceMeasurement(() => now);
    const send = packet => meter.request('https://server/api/application', {method: 'POST', body: JSON.stringify(packet)});
    send({kind: 'bootstrap'}); send({kind: 'queries', calls: Array.from({length: 28}, () => ({method: 'read'}))});
    send({kind: 'bindings', calls: [{method: 'subscribe'}]}); now = 1;
    const result = meter.stop(true);
    assert.equal(result.httpRequests, 3); assert.equal(result.apiCalls, 30);
    assert.equal(assessPerformance(result).passed, false);
});
test('freezes the operation boundary before cleanup traffic', () => {
    let now = 0; const meter = createPerformanceMeasurement(() => now);
    meter.request('/api/application', {method: 'POST', body: JSON.stringify({kind: 'call', call: {method: 'open'}})});
    now = 123; const first = meter.stop(true);
    meter.request('/api/application', {method: 'POST', body: JSON.stringify({kind: 'close'})});now = 9000;
    assert.equal(meter.stop(false), first); assert.equal(first.apiCalls, 1);assert.equal(first.durationMs, 123);
});
test('never treats incomplete operations, malformed requests or absent counts as a pass', () => {
    for (const value of [{completed: false}, {apiCalls: undefined}, {httpRequests: NaN}, {unknownRequests: 1}, {apiCalls: -1}])
        assert.equal(assessPerformance(sample(value)).passed, false);
    const meter = createPerformanceMeasurement();meter.request('/api/application', {method: 'POST', body: 'PRIVATE INVALID BODY'});
    const result = meter.stop(true);assert.equal(assessPerformance(result).passed, false);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test('rejects API-count regressions even when the operation becomes faster', () => {
    const baseline = sample({durationMs: 1000, apiCalls: 10});
    assert.equal(assessPerformance(sample({durationMs: 500, apiCalls: 11}), baseline).passed, false);
    assert.equal(assessPerformance(sample({durationMs: 1300, apiCalls: 10}), baseline).passed, false);
    assert.equal(assessPerformance(sample({durationMs: 1200, apiCalls: 10}), baseline).passed, true);
});
test('requires a passing baseline from the same scenario and dataset', () => {
    for (const baseline of [sample({dataset: 'other'}), sample({scope: 'other'}), sample({apiCalls: 30})])
        assert.equal(assessPerformance(sample(), baseline).passed, false);
});

/** Gates use strict user-operation limits, never per-request timing as a substitute. */
export const PERFORMANCE_LIMITS = Object.freeze({durationMs: 5000, apiCalls: 30});
export function assessPerformance(sample, baseline) {
    const failures = [];
    for (const key of ['durationMs', 'apiCalls', 'httpRequests']) {
        if (!Number.isFinite(sample[key]) || sample[key] < 0 || key !== 'durationMs' && !Number.isSafeInteger(sample[key]))
            failures.push({code: 'METRIC_MISSING_OR_INVALID', metric: key});
    }
    if (sample.completed !== true) failures.push({code: 'OPERATION_NOT_COMPLETED'});
    if (sample.unknownRequests !== 0) failures.push({code: 'REQUEST_COUNT_UNCONFIRMED'});
    for (const [key, limit] of Object.entries(PERFORMANCE_LIMITS))
        if (sample[key] >= limit) failures.push({code: 'BUDGET_EXCEEDED', metric: key, actual: sample[key], limitExclusive: limit});
    if (baseline) compareBaseline(sample, baseline, failures);
    return {passed: failures.length === 0, limits: PERFORMANCE_LIMITS, failures};
}
function compareBaseline(sample, baseline, failures) {
    if (baseline.scope !== sample.scope || baseline.dataset !== sample.dataset || !baseline.dataset ||
        !assessPerformance(baseline).passed) {failures.push({code: 'BASELINE_NOT_COMPARABLE'}); return;}
    // Timing tolerates small noise; adding API calls is a deterministic regression.
    if (sample.durationMs > baseline.durationMs * 1.2 + 50) failures.push({code: 'TIME_REGRESSION'});
    if (sample.apiCalls > baseline.apiCalls) failures.push({code: 'API_COUNT_REGRESSION'});
}
export function createPerformanceMeasurement(clock = () => performance.now()) {
    const started = clock(); let apiCalls = 0, httpRequests = 0, unknownRequests = 0, stopped;
    return {
        request(input, init) {
            if (stopped) return;
            httpRequests++;
            const pathname = new URL(String(input), 'https://measurement.invalid').pathname;
            if (pathname !== '/api/application') {apiCalls++; return;}
            if ((init?.method ?? 'GET') === 'GET') return;
            let packet; try {packet = JSON.parse(init?.body);} catch {unknownRequests++; return;}
            if (packet.kind === 'queries' || packet.kind === 'bindings') {
                if (!Array.isArray(packet.calls) || !packet.calls.length) {unknownRequests++; return;}
                apiCalls += packet.calls.length;
            } else if (packet.kind === 'call' && packet.call && typeof packet.call.method === 'string') apiCalls++;
            else if (['bootstrap', 'bootstrap-data', 'updates-read', 'close', 'reply'].includes(packet.kind)) apiCalls++;
            else unknownRequests++;
        },
        stop(completed, context = {}) {
            return stopped ??= {...context, completed, durationMs: clock() - started, apiCalls, httpRequests, unknownRequests};
        },
    };
}

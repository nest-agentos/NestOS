export interface PerformanceSample {
    completed: boolean;
    durationMs: number;
    apiCalls: number;
    httpRequests: number;
    unknownRequests: number;
    scope?: string;
    dataset?: string;
}
export interface PerformanceFailure {code: string; metric?: string; actual?: number; limitExclusive?: number}
export interface PerformanceAssessment {passed: boolean; limits: Readonly<{durationMs: number; apiCalls: number}>; failures: PerformanceFailure[]}
export const PERFORMANCE_LIMITS: Readonly<{durationMs: number; apiCalls: number}>;
export function assessPerformance(sample: Partial<PerformanceSample>, baseline?: Partial<PerformanceSample>): PerformanceAssessment;
export function createPerformanceMeasurement(clock?: () => number): {
    request(input: RequestInfo | URL, init?: RequestInit): void;
    stop<T extends Record<string, unknown>>(completed: boolean, context?: T): PerformanceSample & T;
};

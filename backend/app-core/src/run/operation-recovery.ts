export interface RecoveryPolicy {retries: number; delayMs: number; maxDelayMs: number}
export interface RecoveryState {attempt: number; limit: number; retryAt: number; code: string; exhausted?: boolean; recovered?: boolean; delayMs: number; maxDelayMs: number}
interface Journal {get<T>(key: string): Promise<T | undefined>; update<T>(key: string, change: (old: T | undefined) => T): Promise<T>}
interface Options {
    journal: Journal; key: string; active(): boolean; policy(): Promise<RecoveryPolicy>;
    retryable(error: unknown): boolean; code(error: unknown): string;
    deferred(state: RecoveryState): Promise<void>;
}
/** Resume the original operation's safe phase; never replay its external submission here. */
export async function recoverOperation(options: Options, work: () => Promise<void>): Promise<void> {
    let state = await options.journal.get<RecoveryState>(options.key);
    if (!options.active()) return;
    if (state?.exhausted) throw Object.assign(new Error('Operation recovery exhausted'), {code: state.code});
    if (state && !state.recovered && state.retryAt > Date.now()) return;
    if (state && !state.recovered) state = await options.journal.update<RecoveryState>(options.key, old => ({...old!, attempt: old!.attempt + 1, retryAt: 0}));
    try {
        await work();
        if (options.active() && state && !state.recovered) await options.journal.update<RecoveryState>(options.key, old => ({...old!, recovered: true}));
    } catch (error) {
        if (!options.active() || !options.retryable(error)) throw error;
        const policy = state && !state.recovered ? {retries: state.limit, delayMs: state.delayMs, maxDelayMs: state.maxDelayMs} : await options.policy();
        const attempt = state && !state.recovered ? state.attempt : 0;
        const next: RecoveryState = {attempt, limit: policy.retries, code: options.code(error), delayMs: policy.delayMs, maxDelayMs: policy.maxDelayMs,
            retryAt: Date.now() + Math.min(policy.delayMs * 2 ** Math.min(attempt, 20), policy.maxDelayMs), exhausted: attempt >= policy.retries};
        await options.journal.update<RecoveryState>(options.key, () => next);
        if (next.exhausted) throw error;
        await options.deferred(next);
    }
}

/** Reject permanent classifications even when a transport wraps them in EIO. */
export function transientOperationFailure(error: unknown): boolean {
    const transient = new Set(['EIO', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENETUNREACH', 'EHOSTUNREACH', 'CONNECTION_CLOSED']);
    let retry = false, uncertain = false;
    for (let depth = 0; depth < 8 && error instanceof Error; depth++, error = error.cause) {
        const value = error as Error & {code?: string; remoteCode?: string; operation?: string; outcome?: string};
        uncertain ||= value.outcome === 'unknown' || value.outcome === 'partial';
        if (value.operation === 'protocol') return false;
        for (const code of [value.code, value.remoteCode]) {
            if (code === 'EBUSY') {
                if (uncertain || value.outcome !== 'not-committed') return false;
                retry = true;
            }
            if (code && /^(EACCES|EPERM|EINVAL|ECAPABILITY|EROFS|STORAGE_CORRUPT|.*_INVALID|.*_MISMATCH|.*_DENIED)$/.test(code)) return false;
            if (code && transient.has(code)) retry = true;
        }
    }
    return retry;
}

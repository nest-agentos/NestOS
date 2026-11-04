/**
 * @file apps/tauri-app/src/log/send-boundary.ts
 * @description Brackets one user send with an exact action boundary for acceptance runs.
 *
 * The P0-02 threshold is defined as "one send to the provider": the backend/IPC calls
 * spent between the user message being accepted and the provider answering it. Neither
 * end is visible in the counters themselves, so the host feeds both in explicitly and
 * the trace records a `send-to-provider` action with its own elapsed time and counts.
 *
 * The window is deliberately not nested: a run may append several messages, but only
 * the user message that starts the run opens a window, and only the first provider
 * response (or a terminal failure) closes it. A bound exists so a send that never
 * answers leaves a visible record instead of silently swallowing the next measurement.
 */
export interface SendBoundaryTarget {
    begin(label: string): number;
    end(id: number): unknown;
}

export interface SendBoundary {
    /** A user message was accepted; opens the window when none is open. */
    accepted(): void;
    /** The provider returned response headers; closes and records the window. */
    responded(): void;
    /** The run ended without a provider response; closes and records the window. */
    abandoned(): void;
}

export interface SendBoundaryOptions {
    /** Upper bound for a window that never gets a provider response. */
    timeoutMs?: number;
}

export function createSendBoundary(target: SendBoundaryTarget, options: SendBoundaryOptions = {}): SendBoundary {
    const timeoutMs = options.timeoutMs ?? 120_000;
    let open: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        if (open === undefined) return;
        const id = open;
        open = undefined;
        target.end(id);
    };
    return {
        accepted() {
            if (open !== undefined) return;
            open = target.begin('send-to-provider');
            timer = setTimeout(close, timeoutMs);
        },
        responded: close,
        abandoned: close,
    };
}

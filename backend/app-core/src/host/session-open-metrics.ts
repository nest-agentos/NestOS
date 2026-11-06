/** Phase timings contain identities and safe classifications, never Session contents. */
export function sessionOpenMetrics(sessionId: string, operationId: string) {
    const identity = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) ? sessionId : undefined;
    return async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        console.info('[SessionOpen]', JSON.stringify({operation: 'session.open', operationId, sessionId: identity, stage, result: 'started'}));
        try {
            const value = await work();
            console.info('[SessionOpen]', JSON.stringify({operation: 'session.open', operationId, sessionId: identity, stage, result: 'success', durationMs: Math.round(performance.now() - started)}));
            return value;
        } catch (error) {
            const raw = (error as {code?: string})?.code, code = /^[A-Z][A-Z0-9_]{0,79}$/.test(raw ?? '') ? raw : 'SESSION_OPEN_FAILED';
            console.warn('[SessionOpen]', JSON.stringify({operation: 'session.open', operationId, sessionId: identity, stage, result: 'failure', code, durationMs: Math.round(performance.now() - started)}));
            throw error;
        }
    };
}
